import webpush from 'web-push';
import { createPinnedHttpsAgent, resolveSafePushEndpoint } from './push-endpoint.js';

export function pushConfiguration(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  return publicKey && privateKey ? { publicKey, privateKey, subject: env.VAPID_SUBJECT || 'mailto:admin@example.com' } : null;
}

export function createPushSender(db, config = pushConfiguration(), resolvePushHostname) {
  if (!config) return async () => ({ sent: 0, configured: false });
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return async ({ memberId, choreName, nextMemberName }) => {
    const subscriptions = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ?').all(memberId);
    let sent = 0;
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        const target = await resolveSafePushEndpoint(subscription.endpoint, resolvePushHostname);
        if (!target) {
          console.warn('Skipping unsafe or unresolvable push endpoint.');
          return;
        }
        const agent = createPinnedHttpsAgent(target);
        try {
          await webpush.sendNotification({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth }
          }, JSON.stringify({
            title: `Your turn: ${choreName}`,
            body: `${nextMemberName}, it’s your turn to help!`,
            url: '/'
          }), { TTL: 60 * 60, agent });
          sent += 1;
        } finally { agent.destroy(); }
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(subscription.id);
        } else {
          console.warn('Push notification failed:', error.statusCode || error.message);
        }
      }
    }));
    return { sent, configured: true };
  };
}
