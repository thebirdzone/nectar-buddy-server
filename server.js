const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://nectarbuddy.netlify.app', 'https://thebirdzone.github.io', 'http://localhost']
}));

// ---- Supabase ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
function todayInTimezone(tz) {
  const ct = new Date().toLocaleString('en-US', { timeZone: tz });
  const d = new Date(ct);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function currentTimeInTimezone(tz) {
  const ct = new Date().toLocaleString('en-US', { timeZone: tz });
  const d = new Date(ct);
  return { hours: d.getHours(), minutes: d.getMinutes() };
}
function daysBetween(d1, d2) { return Math.round((new Date(d2 + 'T12:00:00') - new Date(d1 + 'T12:00:00')) / 86400000); }

async function getTimezone(lat, lon) {
  try {
    const resp = await fetch(`https://timezonefinder.open-meteo.com/v1/find?latitude=${lat}&longitude=${lon}`);
    const data = await resp.json();
    return data.timezone || 'America/Chicago';
  } catch(e) {
    return 'America/Chicago';
  }
}

// ---- Weather fetch ----
async function fetchWeatherForUser(user) {
  const { lat, lon, last_changed, effective_due_date } = user;
  const todayStr = today();
  const maxEnd = new Date(todayStr + 'T12:00:00');
  maxEnd.setDate(maxEnd.getDate() + 5);
  const maxEndStr = maxEnd.toISOString().split('T')[0];
  const forecastEndStr = effective_due_date && effective_due_date < maxEndStr ? effective_due_date : maxEndStr;
  const yesterday = new Date(todayStr + 'T12:00:00');
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const resetDate = last_changed || todayStr;
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
    const due = new Date((last_changed || todayStr) + 'T12:00:00');
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

    await supabase.from('users').update({
      last_temp: w.todayTemp,
      peak_temp: w.peakTemp,
      peak_temp_date: w.peakTempDate,
      peak_type: w.peakType,
      effective_due_date: w.bestDueDate,
      last_checked: new Date().toISOString()
    }).eq('id', user.id);

    if (!user.push_subscription) return;

    let title, body;
    if (daysLeft <= 0) {
      title = '🌺 Change Hummingbird Feeders!';
      body = `It's time to refresh your nectar! (${w.todayTemp}°F today)`;
    } else if (daysLeft === 1) {
      const alreadyNotified = user.last_notified_due_date === w.bestDueDate;
      title = alreadyNotified ? '🌺 Schedule Adjusted' : '🌺 Feeder Change Tomorrow';
      body = alreadyNotified
        ? `Schedule has been adjusted — feeder change now due tomorrow. (${w.todayTemp}°F today)`
        : `Heads-up — change the feeders tomorrow. (${w.todayTemp}°F today)`;
    } else { return; }

    await webpush.sendNotification(user.push_subscription, JSON.stringify({ title, body }));
    await supabase.from('users').update({ last_notified_due_date: w.bestDueDate }).eq('id', user.id);

  } catch (err) {
    console.error(`Error processing user ${user.id}:`, err.message);
  }
}

// ---- Cron: every 15 minutes ----
cron.schedule('*/15 * * * *', async () => {
  const now = new Date();
  const { data: users, error } = await supabase.from('users').select('*').eq('active', true);
  if (error) { console.error('Error fetching users:', error.message); return; }

  for (const user of users) {
    if (!user.notify_time) continue;
    const tz = user.timezone || 'America/Chicago';
    const userNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const hours = userNow.getHours();
    const minutes = userNow.getMinutes();
    const nowMinutes = hours * 60 + minutes;
    const [uHour, uMin] = user.notify_time.split(':').map(Number);
    const userMinutes = uHour * 60 + uMin;
    if (nowMinutes >= userMinutes && nowMinutes < userMinutes + 15) {
      await processUser(user);
    }
  }
});

// ---- Routes ----
app.post('/api/register', async (req, res) => {
  const { id, zip, lat, lon, city, timezone, pushSubscription, notifyTime, active, lastChanged, effectiveDueDate, peakTemp, peakTempDate, peakType, lastNotifiedDueDate } = req.body;
  if (!id || !lat || !lon) return res.status(400).json({ error: 'Missing required fields' });

  const data = {
    id, zip, lat, lon, city,
    timezone: timezone || 'America/Chicago',
    push_subscription: pushSubscription || null,
    notify_time: notifyTime || '08:00',
    active: active || false,
    last_changed: lastChanged || null,
    effective_due_date: effectiveDueDate || null,
    peak_temp: peakTemp || null,
    peak_temp_date: peakTempDate || null,
    peak_type: peakType || null,
    last_notified_due_date: lastNotifiedDueDate || null,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from('users').upsert(data, { onConflict: 'id' });
  if (error) { console.error('Register error:', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

app.post('/api/sync', async (req, res) => {
  const { id, active, notifyTime, lastChanged, effectiveDueDate, peakTemp, peakTempDate, peakType, lastNotifiedDueDate } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const { error } = await supabase.from('users').update({
    active,
    notify_time: notifyTime || '08:00',
    last_changed: lastChanged || null,
    effective_due_date: effectiveDueDate || null,
    peak_temp: peakTemp || null,
    peak_temp_date: peakTempDate || null,
    peak_type: peakType || null,
    last_notified_due_date: lastNotifiedDueDate || null,
    updated_at: new Date().toISOString()
  }).eq('id', id);

  if (error) { console.error('Sync error:', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.get('/api/debug-users', async (req, res) => {
  const { data: users, error } = await supabase.from('users').select('id, zip, city, active, notify_time, last_changed, effective_due_date, updated_at, push_subscription');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: users.length, users: users.map(u => ({ ...u, hasPushSub: !!u.push_subscription, push_subscription: undefined })) });
});

app.get('/api/test-notify', async (req, res) => {
  const { data: users, error } = await supabase.from('users').select('*');
  if (error) return res.status(500).json({ error: error.message });
  if (!users || users.length === 0) return res.status(404).json({ error: 'No users found' });
  const results = [];
  for (const user of users) {
    if (!user.push_subscription) { results.push({ id: user.id, result: 'no push subscription' }); continue; }
    try {
      await webpush.sendNotification(user.push_subscription, JSON.stringify({
        title: '🌺 Nectar Buddy Test',
        body: 'Push notifications are working!'
      }));
      results.push({ id: user.id, result: 'sent' });
    } catch(e) {
      results.push({ id: user.id, result: 'failed: ' + e.message });
    }
  }
  res.json({ results });
});

app.get('/', (req, res) => res.json({ status: 'Nectar Buddy server running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nectar Buddy server running on port ${PORT}`));
