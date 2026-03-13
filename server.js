const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://nectarbuddy.netlify.app', 'http://localhost']
}));

// ---- Database ----
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ users: [] }).write();

// ---- VAPID Keys ----
webpush.setVapidDetails(
  'mailto:' + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ---- Schedule logic ----
function getInterval(t) {
  if (t >= 93) return 1; if (t >= 89) return 2; if (t >= 85) return 3;
  if (t >= 81) return 4; if (t >= 76) return 5; return 6;
}
function today() { return new Date().toISOString().split('T')[0]; }
function daysBetween(d1, d2) { return Math.round((new Date(d2) - new Date(d1)) / 86400000); }

// ---- Weather fetch ----
async function fetchWeatherForUser(user) {
  const { lat, lon, lastChanged, effectiveDueDate } = user;
  const todayStr = today();
  const maxEnd = new Date(todayStr + 'T12:00:00');
  maxEnd.setDate(maxEnd.getDate() + 5);
  const maxEndStr = maxEnd.toISOString().split('T')[0];
  const forecastEndStr = effectiveDueDate && effectiveDueDate < maxEndStr ? effectiveDueDate : maxEndStr;
  const yesterday = new Date(todayStr + 'T12:00:00');
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const resetDate = lastChanged || todayStr;
  const allTemps = [];

  const fResp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&start_date=${todayStr}&end_date=${forecastEndStr}&timezone=auto`);
  const fData = await fResp.json();
  if (fData.daily && fData.daily.temperature_2m_max) {
    fData.daily.time.forEach((date, i) => {
      const t = fData.daily.temperature_2m_max[i];
      if (t != null) allTemps.push({ date, temp: Math.round(t), type: 'forecast' });
    });
  }

  if (resetDate < todayStr) {
    const aResp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&start_date=${resetDate}&end_date=${yesterdayStr}&timezone=auto`);
    const aData = await aResp.json();
    if (aData.daily && aData.daily.temperature_2m_max) {
      aData.daily.time.forEach((date, i) => {
        const t = aData.daily.temperature_2m_max[i];
        if (t != null) {
          const ex = allTemps.findIndex(x => x.date === date);
          if (ex >= 0) allTemps[ex] = { date, temp: Math.round(t), type: 'actual' };
          else allTemps.push({ date, temp: Math.round(t), type: 'actual' });
        }
      });
    }
  }

  let peakTemp = null, peakTempDate = null, peakType = null, bestDueDate = null;
  allTemps.forEach(entry => {
    const interval = getInterval(entry.temp);
    const due = new Date((lastChanged || todayStr) + 'T12:00:00');
    due.setDate(due.getDate() + interval);
    let dueDateStr = due.toISOString().split('T')[0];
    if (entry.type === 'forecast' && entry.date > todayStr && dueDateStr < entry.date) dueDateStr = entry.date;
    if (bestDueDate === null || dueDateStr < bestDueDate) {
      bestDueDate = dueDateStr; peakTemp = entry.temp; peakTempDate = entry.date; peakType = entry.type;
    }
  });

  const todayEntry = allTemps.find(x => x.date === todayStr);
  return { todayTemp: todayEntry ? todayEntry.temp : peakTemp, peakTemp, peakTempDate, peakType, bestDueDate };
}

// ---- Process user notification ----
async function processUser(user) {
  try {
    const w = await fetchWeatherForUser(user);
    if (!w.bestDueDate) return;
    const daysLeft = daysBetween(today(), w.bestDueDate);

    db.get('users').find({ id: user.id }).assign({
      lastTemp: w.todayTemp, peakTemp: w.peakTemp, peakTempDate: w.peakTempDate,
      peakType: w.peakType, effectiveDueDate: w.bestDueDate, lastChecked: new Date().toISOString()
    }).write();

    if (!user.pushSubscription) return;

    let title, body;
    if (daysLeft <= 0) {
      title = '🌺 Change Hummingbird Feeders!';
      body = `It's time to refresh your nectar! (${w.todayTemp}°F today)`;
    } else if (daysLeft === 1) {
      const alreadyNotified = user.lastNotifiedDueDate === w.bestDueDate;
      title = alreadyNotified ? '🌺 Schedule Adjusted' : '🌺 Feeder Change Tomorrow';
      body = alreadyNotified
        ? `Schedule has been adjusted — feeder change now due tomorrow. (${w.todayTemp}°F today)`
        : `Heads-up — change the feeders tomorrow. (${w.todayTemp}°F today)`;
    } else { return; }

    await webpush.sendNotification(user.pushSubscription, JSON.stringify({ title, body }));
    db.get('users').find({ id: user.id }).assign({ lastNotifiedDueDate: w.bestDueDate }).write();

  } catch (err) {
    console.error(`Error processing user ${user.id}:`, err.message);
  }
}

// ---- Cron: every 15 minutes ----
cron.schedule('*/15 * * * *', async () => {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hours = ct.getHours();
  const minutes = ct.getMinutes();
  const nowMinutes = hours * 60 + minutes;

  const users = db.get('users').value();
  for (const user of users) {
    if (!user.active || !user.notifyTime) continue;
    const [uHour, uMin] = user.notifyTime.split(':').map(Number);
    const userMinutes = uHour * 60 + uMin;
    if (nowMinutes >= userMinutes && nowMinutes < userMinutes + 15) {
      await processUser(user);
    }
  }
});

// ---- Routes ----
app.post('/api/register', (req, res) => {
  const { id, zip, lat, lon, city, pushSubscription, notifyTime, active, lastChanged, effectiveDueDate, peakTemp, peakTempDate, peakType, lastNotifiedDueDate } = req.body;
  if (!id || !lat || !lon) return res.status(400).json({ error: 'Missing required fields' });
  const existing = db.get('users').find({ id }).value();
  const data = { id, zip, lat, lon, city, pushSubscription, notifyTime, active, lastChanged, effectiveDueDate, peakTemp, peakTempDate, peakType, lastNotifiedDueDate, updatedAt: new Date().toISOString() };
  if (existing) { db.get('users').find({ id }).assign(data).write(); }
  else { db.get('users').push({ ...data, createdAt: new Date().toISOString() }).write(); }
  res.json({ success: true });
});

app.post('/api/sync', (req, res) => {
  const { id, active, lastChanged, effectiveDueDate, peakTemp, peakTempDate, peakType, lastNotifiedDueDate } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  db.get('users').find({ id }).assign({ active, lastChanged, effectiveDueDate, peakTemp, peakTempDate, peakType, lastNotifiedDueDate, updatedAt: new Date().toISOString() }).write();
  res.json({ success: true });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.get('/', (req, res) => res.json({ status: 'Nectar Buddy server running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nectar Buddy server running on port ${PORT}`));
