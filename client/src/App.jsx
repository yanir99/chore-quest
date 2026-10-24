import { useEffect, useMemo, useState } from 'react';
import './auth.css';

const iconFor = (name = '') => {
  const value = name.toLowerCase();
  if (value.includes('litter') || value.includes('cat')) return '🐈';
  if (value.includes('dish') || value.includes('washer')) return '🍽️';
  if (value.includes('fold')) return '🧺';
  if (value.includes('hang') || value.includes('laundry')) return '👕';
  return '🧹';
};

async function request(path, options = {}) {
  const { body, ...rest } = options;
  const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(rest.headers || {}) };
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...rest, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const error = new Error(details.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function percent(value, goal) { return Math.min(100, Math.round((Number(value || 0) / Math.max(1, Number(goal || 1))) * 100)); }
function timeAgo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

function NotificationSetup({ child, notify }) {
  const [config, setConfig] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [busy, setBusy] = useState(false);
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  useEffect(() => {
    request('/push/config').then(setConfig).catch(() => setConfig({ enabled: false }));
  }, []);
  useEffect(() => {
    let alive = true;
    if (capable) navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()).then((value) => { if (alive) setSubscription(value); }).catch(() => {});
    return () => { alive = false; };
  }, [capable]);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications are blocked in your browser settings.');
      const registration = await navigator.serviceWorker.ready;
      const value = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
      await request('/push/subscriptions', { method: 'POST', body: { memberId: child.id, subscription: value.toJSON() } });
      setSubscription(value);
      notify(`Turn alerts are on for ${child.name}!`);
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true);
    try {
      if (subscription) {
        await request('/push/subscriptions', { method: 'DELETE', body: { memberId: child.id, endpoint: subscription.endpoint } });
        await subscription.unsubscribe();
      }
      setSubscription(null);
      notify('Turn alerts turned off on this device.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  }

  if (!capable) return <div className="notice notice-soft">This browser does not support push alerts. Chore tracking still works here.</div>;
  if (isIOS && !installed) return <div className="notice notice-soft"><strong>Want turn alerts?</strong><span>In Safari, tap Share → Add to Home Screen, open Chore Quest from its new icon, then turn alerts on.</span></div>;
  if (!config) return <div className="notice notice-soft">Checking notification setup…</div>;
  if (!config.enabled) return <div className="notice notice-soft"><strong>Turn alerts need a quick setup.</strong><span>Ask a parent to add VAPID keys to the server settings. This device can still log chores.</span></div>;
  return <div className="notification-row">
    <div><strong>🔔 Turn alerts</strong><small>{subscription ? `Enabled on this device for ${child.name}` : `Notify ${child.name} when it’s their turn`}</small></div>
    <button className={subscription ? 'button button-quiet' : 'button button-small'} disabled={busy} onClick={subscription ? disable : enable}>{busy ? 'One sec…' : subscription ? 'Turn off' : 'Turn on'}</button>
  </div>;
}

function LoginScreen({ onChildLogin, onParentLogin, error, busy }) {
  const [childPin, setChildPin] = useState('');
  const [parentPin, setParentPin] = useState('');
  const [parentOpen, setParentOpen] = useState(false);
  return <main className="auth-screen"><section className="auth-card">
    <a className="brand auth-brand" href="/" aria-label="Chore Quest"><span className="brand-mark">🐾</span><span>Chore<span className="brand-highlight">Quest</span></span></a>
    <div className="auth-illustration" aria-hidden="true">🗺️✨</div>
    <span className="eyebrow">YOUR FAMILY CHORE BOARD</span><h1>Ready for a chore quest?</h1>
    <p>Enter your own PIN to open the shared family dashboard as you.</p>
    <form className="auth-form" onSubmit={(event) => { event.preventDefault(); onChildLogin(childPin); }}>
      <label>Child PIN<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength="4" maxLength="8" autoComplete="current-password" aria-label="Child PIN" value={childPin} onChange={(event) => setChildPin(event.target.value.replace(/\D/g, '').slice(0, 8))} required /></label>
      <button className="button" disabled={busy || childPin.length < 4}>{busy ? 'Signing in…' : 'Open my dashboard'}</button>
    </form>
    {error && <div className="auth-error" role="alert">{error}</div>}
    <div className="auth-divider"><span>Grown-ups</span></div>
    {!parentOpen ? <button className="button button-quiet auth-parent-button" onClick={() => setParentOpen(true)}>Parent sign in</button> : <form className="auth-form parent-auth-form" onSubmit={(event) => { event.preventDefault(); onParentLogin(parentPin); }}>
      <label>Parent PIN<input type="password" autoComplete="current-password" aria-label="Parent PIN" value={parentPin} onChange={(event) => setParentPin(event.target.value)} required /></label>
      <div><button type="button" className="button button-quiet" onClick={() => setParentOpen(false)}>Cancel</button><button className="button" disabled={busy || !parentPin}>{busy ? 'Signing in…' : 'Sign in as parent'}</button></div>
    </form>}
    <small className="auth-hint">First-time setup? Parent sign in, open House settings, and set a PIN for each child.</small>
  </section></main>;
}

function ParentPanel({ data, refresh, close, notify }) {
  const [saving, setSaving] = useState(false);
  const [goal, setGoal] = useState(data.weeklyGoalPoints);
  const [newChore, setNewChore] = useState({ name: '', targetPerDay: 1, unit: '', points: 10 });
  const [childNames, setChildNames] = useState(Object.fromEntries(data.children.map((child) => [child.id, child.name])));
  const [childPins, setChildPins] = useState({});
  const [newChild, setNewChild] = useState({ name: '', pin: '' });

  useEffect(() => {
    setChildNames(Object.fromEntries(data.children.map((child) => [child.id, child.name])));
    setGoal(data.weeklyGoalPoints);
  }, [data.children, data.weeklyGoalPoints]);

  async function save(action, success = 'Saved!') {
    setSaving(true);
    try { await action(); await refresh(); notify(success); return true; }
    catch (error) { notify(error.message); return false; }
    finally { setSaving(false); }
  }

  async function saveChildPin(event, child) {
    event.preventDefault();
    const pin = childPins[child.id] || '';
    const saved = await save(() => request(`/children/${child.id}/pin`, { method: 'PATCH', body: { pin } }), child.pinConfigured ? `PIN reset for ${child.name}.` : `PIN set for ${child.name}.`);
    if (saved) setChildPins((current) => ({ ...current, [child.id]: '' }));
  }

  async function addChild(event) {
    event.preventDefault();
    const saved = await save(() => request('/children', { method: 'POST', body: newChild }), `${newChild.name.trim()} added!`);
    if (saved) setNewChild({ name: '', pin: '' });
  }

  function saveChore(event, chore) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get('name')).trim(), targetPerDay: Number(form.get('targetPerDay')),
      unit: String(form.get('unit')).trim(), points: Number(form.get('points'))
    };
    return save(() => request(`/chores/${chore.id}`, { method: 'PATCH', body: payload }), 'Chore updated!');
  }

  function saveLog(event, log) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return save(() => request(`/logs/${log.id}`, { method: 'PATCH', body: { memberId: Number(form.get('memberId')), quantity: Number(form.get('quantity')) } }), 'Log corrected.');
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="parent-panel" role="dialog" aria-modal="true" aria-labelledby="parent-title">
      <div className="panel-heading"><div><span className="eyebrow">GROWN-UP CORNER</span><h2 id="parent-title">House settings 🛠️</h2></div><button className="icon-button" aria-label="Close settings" onClick={close}>×</button></div>
      <div className="panel-section"><h3>Kid profiles & PINs</h3>
        <div className="child-profile-list">{data.children.map((child) => <article className="child-setting-card" key={child.id}>
          <form className="inline-form" onSubmit={(event) => { event.preventDefault(); save(() => request(`/children/${child.id}`, { method: 'PATCH', body: { name: childNames[child.id] } }), 'Name updated!'); }}>
            <span className="profile-emoji">{child.avatar}</span><input aria-label={`${child.name} name`} maxLength="32" value={childNames[child.id] || ''} onChange={(event) => setChildNames({ ...childNames, [child.id]: event.target.value })} /><button className="button button-small" disabled={saving}>Save name</button>
          </form>
          <div className="child-pin-row"><span className={child.pinConfigured ? 'pin-status is-set' : 'pin-status'}>{child.pinConfigured ? 'PIN set' : 'PIN not set'}</span>
            <form className="child-pin-form" onSubmit={(event) => saveChildPin(event, child)}>
              <input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength="4" maxLength="8" autoComplete="new-password" aria-label={`${child.name} new PIN`} placeholder="4–8 digit PIN" value={childPins[child.id] || ''} onChange={(event) => setChildPins({ ...childPins, [child.id]: event.target.value.replace(/\D/g, '').slice(0, 8) })} required />
              <button className="button button-small" disabled={saving}>{child.pinConfigured ? 'Reset PIN' : 'Set PIN'}</button>
            </form>
          </div>
        </article>)}</div>
        <form className="add-child-form" onSubmit={addChild}>
          <h4>＋ Add a kid</h4>
          <label>Name<input aria-label="New kid name" maxLength="32" value={newChild.name} onChange={(event) => setNewChild({ ...newChild, name: event.target.value })} required /></label>
          <label>PIN<input type="password" inputMode="numeric" pattern="[0-9]{4,8}" minLength="4" maxLength="8" autoComplete="new-password" aria-label="New kid PIN" value={newChild.pin} onChange={(event) => setNewChild({ ...newChild, pin: event.target.value.replace(/\D/g, '').slice(0, 8) })} required /></label>
          <button className="button" disabled={saving || !newChild.name.trim() || newChild.pin.length < 4}>Add kid</button>
          <small>Every child needs a unique 4–8 digit PIN.</small>
        </form>
      </div>
      <div className="panel-section"><h3>Weekly teamwork goal</h3>
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); save(() => request('/settings', { method: 'PATCH', body: { weeklyGoalPoints: Number(goal) } }), 'Weekly goal saved!'); }}>
          <label>Points for the family <input type="number" min="1" max="5000" value={goal} onChange={(event) => setGoal(event.target.value)} /></label><button className="button button-small" disabled={saving}>Save goal</button>
        </form>
      </div>
      <div className="panel-section"><h3>Chore board</h3><p className="muted">Targets are completions per day. Add a unit like “loads” when a chore needs a quantity.</p>
        <div className="admin-chores">{data.chores.map((chore) => <form className="admin-chore" key={chore.id} onSubmit={(event) => saveChore(event, chore)}>
          <input name="name" aria-label="Chore name" defaultValue={chore.name} maxLength="60" required />
          <label>Daily target<input name="targetPerDay" type="number" min="1" max="20" defaultValue={chore.targetPerDay} required /></label>
          <label>Quantity unit<input name="unit" defaultValue={chore.unit} maxLength="24" placeholder="e.g. loads" /></label>
          <label>Points<input name="points" type="number" min="1" max="100" defaultValue={chore.points} required /></label>
          <button className="button button-small" disabled={saving}>Save</button>
          <button type="button" className="button button-danger button-small" disabled={saving} onClick={() => { if (window.confirm(`Remove ${chore.name} from the board? Past logs are kept.`)) save(() => request(`/chores/${chore.id}`, { method: 'DELETE' }), 'Chore removed.'); }}>Remove</button>
        </form>)}</div>
        <form className="new-chore-form" onSubmit={(event) => { event.preventDefault(); save(() => request('/chores', { method: 'POST', body: { ...newChore, targetPerDay: Number(newChore.targetPerDay), points: Number(newChore.points) } }), 'New chore added!').then(() => setNewChore({ name: '', targetPerDay: 1, unit: '', points: 10 })); }}>
          <h4>＋ Add a chore</h4><input aria-label="New chore name" placeholder="Chore name" maxLength="60" value={newChore.name} onChange={(event) => setNewChore({ ...newChore, name: event.target.value })} required />
          <label>Times/day<input type="number" min="1" max="20" value={newChore.targetPerDay} onChange={(event) => setNewChore({ ...newChore, targetPerDay: event.target.value })} /></label>
          <input aria-label="Quantity unit" placeholder="Unit (optional)" maxLength="24" value={newChore.unit} onChange={(event) => setNewChore({ ...newChore, unit: event.target.value })} />
          <label>Points<input type="number" min="1" max="100" value={newChore.points} onChange={(event) => setNewChore({ ...newChore, points: event.target.value })} /></label>
          <button className="button" disabled={saving || !newChore.name.trim()}>Add to board</button>
        </form>
      </div>
      <div className="panel-section"><h3>Recent log fixes</h3><p className="muted">Correct who did it or the quantity. Deleting a log does not rewind the next-turn rotation.</p>
        <div className="log-fixes">{data.logs.slice(0, 12).map((log) => <form key={log.id} className="log-fix" onSubmit={(event) => saveLog(event, log)}>
          <div className="log-fix-title"><span>{iconFor(log.choreName)} {log.choreName}</span><small>{timeAgo(log.completedAt)}</small></div>
          <select name="memberId" aria-label="Correct child" defaultValue={log.memberId}>{data.children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}</select>
          <input name="quantity" aria-label="Correct quantity" type="number" min="0.1" max="100" step="0.1" defaultValue={log.quantity} />
          <button className="button button-small" disabled={saving}>Fix</button>
          <button type="button" aria-label={`Delete ${log.choreName} log`} className="button button-danger button-small" disabled={saving} onClick={() => { if (window.confirm('Delete this log entry?')) save(() => request(`/logs/${log.id}`, { method: 'DELETE' }), 'Log deleted.'); }}>×</button>
        </form>)}</div>
      </div>
      <div className="panel-footer"><span>🔐 Parent session is active on this device.</span><button className="button button-quiet" onClick={close}>Done</button></div>
    </section>
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [auth, setAuth] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyChore, setBusyChore] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [loginError, setLoginError] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [showParent, setShowParent] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const child = useMemo(() => {
    if (!data) return null;
    const memberId = auth?.role === 'child' ? auth.child.id : selectedId;
    return data.children.find((item) => item.id === memberId) || data.children[0];
  }, [data, auth, selectedId]);

  async function refresh() {
    try {
      const next = await request('/data');
      setData(next);
      setSelectedId((current) => auth?.role === 'child' ? auth.child.id : (next.children.some((item) => item.id === current) ? current : next.children[0]?.id || null));
      return next;
    } catch (error) {
      if (error.status === 401) { setAuth(null); setData(null); setShowParent(false); }
      setToast(error.message);
      throw error;
    } finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const session = await request('/auth/me');
        const next = await request('/data');
        if (!active) return;
        setAuth(session);
        setData(next);
        setSelectedId(session.role === 'child' ? session.child.id : next.children[0]?.id || null);
      } catch (error) {
        if (!active) return;
        setAuth(null);
        setData(null);
        if (error.status !== 401) setLoginError(error.message);
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3200); return () => clearTimeout(timer); }, [toast]);

  async function signIn(endpoint, pin) {
    setAuthBusy(true);
    setLoginError('');
    try {
      const session = await request(`/auth/${endpoint}-login`, { method: 'POST', body: { pin } });
      const next = await request('/data');
      setAuth(session);
      setData(next);
      setSelectedId(session.role === 'child' ? session.child.id : next.children[0]?.id || null);
      setPinOpen(false);
      setShowParent(false);
      setShowAlerts(false);
      setToast(session.role === 'parent' ? 'Parent signed in. Settings are unlocked.' : `Welcome, ${session.child.name}!`);
      return true;
    } catch (error) { setLoginError(error.message); return false; }
    finally { setAuthBusy(false); }
  }

  async function logChore(chore) {
    if (!child) return;
    setBusyChore(chore.id);
    try {
      const quantity = Number(quantities[chore.id] || 1);
      const body = { choreId: chore.id, quantity };
      if (auth.role === 'parent') body.memberId = child.id;
      const result = await request('/logs', { method: 'POST', body });
      setData(result.dashboard);
      setToast(`${iconFor(chore.name)} Nice work, ${child.name}! ${result.nextMember.name} is up next.`);
      setQuantities({ ...quantities, [chore.id]: 1 });
    } catch (error) {
      if (error.status === 401) { setAuth(null); setData(null); }
      setToast(error.message);
    } finally { setBusyChore(null); }
  }

  function openParent() {
    if (auth.role === 'parent') { setShowParent(true); return; }
    setPinInput('');
    setPinError('');
    setPinOpen(true);
  }
  async function verifyParent(event) {
    event.preventDefault();
    setAuthBusy(true);
    setPinError('');
    try {
      const session = await request('/auth/parent-login', { method: 'POST', body: { pin: pinInput } });
      setAuth(session);
      setPinOpen(false);
      setPinInput('');
      setShowParent(true);
      await refresh();
      setToast('Parent session unlocked. Settings will not ask for the PIN again.');
    } catch (error) { setPinError(error.message); }
    finally { setAuthBusy(false); }
  }
  function closeParent() { setShowParent(false); }
  async function logout() {
    try { await request('/auth/logout', { method: 'POST' }); } catch {}
    setAuth(null);
    setData(null);
    setSelectedId(null);
    setShowParent(false);
    setShowAlerts(false);
    setPinOpen(false);
    setLoginError('');
    setToast('');
  }

  if (loading && !auth) return <main className="loading-screen"><div className="loader">🧺</div><p>Checking your family PIN…</p></main>;
  if (!auth) return <LoginScreen onChildLogin={(pin) => signIn('child', pin)} onParentLogin={(pin) => signIn('parent', pin)} error={loginError} busy={authBusy} />;
  if (!data || !child) return <main className="loading-screen"><h1>Oops!</h1><p>{toast || 'Could not load the family chore board.'}</p><button className="button" onClick={() => refresh().catch(() => {})}>Try again</button><button className="button button-quiet" onClick={logout}>Switch user</button></main>;

  return <main className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Chore Quest home"><span className="brand-mark">🐾</span><span>Chore<span className="brand-highlight">Quest</span></span></a>
      <div className="top-actions"><button className="button button-quiet alert-link" onClick={() => setShowAlerts(!showAlerts)}>🔔 <span>Turn alerts</span></button><button className="parent-link" onClick={openParent}>{auth.role === 'parent' ? 'House settings' : 'Parent access'}</button><button className="parent-link switch-user-link" onClick={logout}>Switch user</button></div>
    </header>
    <section className="welcome-card"><div className="welcome-copy"><div className="eyebrow">A LITTLE TEAMWORK GOES A LONG WAY</div><h1>Hey, {child.name}! <span aria-hidden="true">🌈</span></h1><p>Pick a chore, give it your best, and earn some points for the team.</p>
      {auth.role === 'parent' ? <div className="family-pickers" aria-label="Choose child identity for parent logging">{data.children.map((kid) => <button key={kid.id} className={`kid-pill ${kid.id === child.id ? 'selected' : ''}`} onClick={() => setSelectedId(kid.id)}><span>{kid.avatar}</span>{kid.name}{kid.id === child.id && <b>✓</b>}</button>)}</div> : <div className="identity-locked">🔐 Signed in as <strong>{child.name}</strong> · chores are logged only for this child.</div>}
    </div><div className="welcome-art" aria-hidden="true"><span className="sun">☀️</span><span className="art-basket">🧺</span><span className="spark spark-one">✦</span><span className="spark spark-two">✦</span></div></section>

    {showAlerts && <section className="alert-card"><div><span className="alert-card-icon">📣</span><div><strong>Never miss your turn</strong><p>Get a friendly heads-up whenever a chore passes to you.</p></div></div><NotificationSetup child={child} notify={setToast} /><button className="alert-close" onClick={() => setShowAlerts(false)} aria-label="Close alerts">×</button></section>}

    <div className="section-heading"><div><span className="eyebrow">TODAY'S ADVENTURES</span><h2>Chore board <span>🗺️</span></h2></div><span className="today-label">{new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>
    <section className="chore-grid">{data.chores.map((chore, index) => {
      const isComplete = chore.doneToday >= chore.targetPerDay;
      const quantity = quantities[chore.id] ?? 1;
      return <article className={`chore-card chore-color-${index % 4}`} key={chore.id}>
        <div className="chore-topline"><span className="chore-icon">{iconFor(chore.name)}</span><span className="points-chip">+{chore.points} pts</span></div>
        <h3>{chore.name}</h3><p className="chore-progress">{isComplete ? 'All done for today!' : `${chore.doneToday} of ${chore.targetPerDay} done today`}</p>
        <div className="progress-track"><span style={{ width: `${percent(chore.doneToday, chore.targetPerDay)}%` }} /></div>
        <div className="next-turn"><span className="turn-avatar">{chore.nextMemberAvatar}</span><span><small>NEXT UP</small><strong>{chore.nextMemberName}</strong></span><span className="turn-arrow">↗</span></div>
        {chore.unit && <label className="quantity-control"><span>How many {chore.unit}?</span><div><button type="button" aria-label="Decrease quantity" onClick={() => setQuantities({ ...quantities, [chore.id]: Math.max(0.1, Number(quantity) - 1) })}>−</button><input aria-label={`Quantity for ${chore.name}`} type="number" min="0.1" max="100" step="0.1" value={quantity} onChange={(event) => setQuantities({ ...quantities, [chore.id]: event.target.value })} /><button type="button" aria-label="Increase quantity" onClick={() => setQuantities({ ...quantities, [chore.id]: Number(quantity) + 1 })}>＋</button></div></label>}
        <button className="button log-button" disabled={busyChore === chore.id} onClick={() => logChore(chore)}>{busyChore === chore.id ? 'Logging…' : isComplete ? 'Did it again! ✨' : 'I did this! 🎉'}</button>
      </article>;
    })}{data.chores.length === 0 && <div className="empty-board">No active chores yet. A parent can add the first one in settings! 🌱</div>}</section>

    <section className="bottom-grid"><article className="score-card"><div className="section-heading compact"><div><span className="eyebrow">FAMILY TEAMWORK</span><h2>Weekly stars <span>⭐</span></h2></div><span className="goal-label">Goal: {data.weeklyGoalPoints} pts</span></div>
      <div className="score-list">{data.scores.map((score) => <div className={`score-row ${score.memberId === child.id ? 'score-current' : ''}`} key={score.memberId}>
        <span className="score-avatar">{score.avatar}</span><div className="score-info"><div><strong>{score.name}</strong><small>{score.points >= 100 ? '🏆 Chore Champion' : score.points >= 50 ? '⭐ Super Helper' : score.points > 0 ? '✨ First Spark' : '🌱 Ready to start'}</small></div><div className="score-track"><span style={{ width: `${percent(score.points, data.weeklyGoalPoints)}%` }} /></div></div><b className="score-number">{score.points}<small>pts</small></b>
      </div>)}
      </div>
      <div className="goal-note">{data.scores.reduce((total, score) => total + score.points, 0) >= data.weeklyGoalPoints ? '🎊 You hit the family goal — amazing teamwork!' : `You’re ${Math.max(0, data.weeklyGoalPoints - data.scores.reduce((total, score) => total + score.points, 0))} points from your family goal!`}</div>
    </article>
    <article className="activity-card"><div className="section-heading compact"><div><span className="eyebrow">HIGH-FIVES ALL AROUND</span><h2>Recent activity <span>💬</span></h2></div></div>
      <div className="activity-list">{data.logs.slice(0, 8).map((log) => <div className="activity-item" key={log.id}><span className="activity-icon">{iconFor(log.choreName)}</span><div><strong>{log.memberName} <span>did</span> {log.choreName}</strong><small>{log.quantity}{log.unit ? ` ${log.unit}` : ''} · {timeAgo(log.completedAt)}</small></div><span className="activity-points">+{log.points}</span></div>)}{data.logs.length === 0 && <p className="muted empty-activity">No chores logged yet. Your first high-five is waiting! ✨</p>}</div>
    </article></section>

    <footer className="footer"><span>Made for little helpers and big teamwork 💛</span><button onClick={() => refresh().catch(() => {})}>↻ Refresh board</button></footer>
    {toast && <div className="toast" role="status">{toast}</div>}
    {pinOpen && <div className="modal-backdrop"><form className="pin-dialog" role="dialog" aria-modal="true" aria-labelledby="pin-title" onSubmit={verifyParent}>
      <span className="pin-icon">🔐</span><h2 id="pin-title">Parent PIN</h2><p>Sign in once to manage settings on this device.</p>
      <input autoFocus type="password" autoComplete="current-password" aria-label="Parent PIN" value={pinInput} onChange={(event) => setPinInput(event.target.value)} required />
      {pinError && <div className="auth-error" role="alert">{pinError}</div>}
      <div><button type="button" className="button button-quiet" onClick={() => { setPinOpen(false); setPinError(''); }}>Cancel</button><button className="button" disabled={!pinInput || authBusy}>{authBusy ? 'Signing in…' : 'Continue'}</button></div>
    </form></div>}
    {showParent && auth.role === 'parent' && <ParentPanel data={data} refresh={refresh} close={closeParent} notify={setToast} />}
  </main>;
}
