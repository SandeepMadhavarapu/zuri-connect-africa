/**
 * Zuri Connect Africa — Notification Infrastructure
 * Handles SMS, push, email, fraud alerts, and receipt delivery.
 * Retry with exponential backoff, sessionStorage-backed queue.
 */

import { emit } from './eventBus';

const NOTIF_QUEUE_KEY = 'zuri_notif_queue';
const MAX_RETRIES     = 3;

export const NOTIF_TYPE = {
  SMS:         'sms',
  PUSH:        'push',
  EMAIL:       'email',
  FRAUD_ALERT: 'fraud_alert',
  RECEIPT:     'receipt',
};

export const NOTIF_STATUS = {
  QUEUED:     'queued',
  DELIVERING: 'delivering',
  DELIVERED:  'delivered',
  FAILED:     'failed',
};

// ── Storage ───────────────────────────────────────────────────────────────────

function readQueue() {
  try { return JSON.parse(sessionStorage.getItem(NOTIF_QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function writeQueue(q) {
  sessionStorage.setItem(NOTIF_QUEUE_KEY, JSON.stringify(q));
}

function generateId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function backoffMs(retryCount) {
  return Math.min(1000 * Math.pow(2, retryCount), 16000);
}

// ── Simulate delivery ─────────────────────────────────────────────────────────
// In production: Safaricom SMS API / Firebase FCM / Sendgrid

async function deliverNotification(notif) {
  await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
  // 97% delivery success in demo
  if (Math.random() > 0.03) return { success: true };
  return { success: false, error: 'Carrier gateway timeout' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a notification immediately (queues internally, processes async).
 */
export async function sendNotification(type, userId, payload) {
  const notif = {
    notificationId: generateId(),
    type,
    userId,
    payload,
    status:       NOTIF_STATUS.QUEUED,
    createdAt:    Date.now(),
    deliveredAt:  null,
    retryCount:   0,
    nextRetryAt:  null,
    lastError:    null,
  };
  return queueNotification(notif);
}

/**
 * Add a pre-built notification object to the queue.
 */
export function queueNotification(notif) {
  const q = readQueue();
  const existing = q.find(n => n.notificationId === notif.notificationId);
  if (existing) return existing;
  q.push({ ...notif, status: NOTIF_STATUS.QUEUED });
  writeQueue(q);
  setTimeout(() => processNotificationQueue(), 0);
  return notif;
}

/**
 * Process all queued / retry-eligible notifications.
 */
export async function processNotificationQueue() {
  const q   = readQueue();
  const now = Date.now();

  const eligible = q.filter(n =>
    n.status === NOTIF_STATUS.QUEUED ||
    (n.status === NOTIF_STATUS.FAILED && n.nextRetryAt && now >= n.nextRetryAt)
  );

  for (const notif of eligible) {
    notif.status = NOTIF_STATUS.DELIVERING;
    writeQueue(q);

    const result = await deliverNotification(notif);

    if (result.success) {
      notif.status      = NOTIF_STATUS.DELIVERED;
      notif.deliveredAt = Date.now();
      notif.lastError   = null;
      emit('PAYMENT_SETTLED', { notificationId: notif.notificationId, type: notif.type, userId: notif.userId });
    } else {
      notif.retryCount++;
      notif.lastError = result.error;
      if (notif.retryCount >= MAX_RETRIES) {
        notif.status = NOTIF_STATUS.FAILED;
        emit('PAYMENT_FAILED', { notificationId: notif.notificationId, error: result.error });
        console.warn(`[Notifications] Dead — ${notif.notificationId} after ${MAX_RETRIES} retries`);
      } else {
        notif.status      = NOTIF_STATUS.FAILED;
        notif.nextRetryAt = Date.now() + backoffMs(notif.retryCount);
      }
    }
    writeQueue(q);
  }
}

/**
 * Get delivery status for a specific notification.
 */
export function getDeliveryStatus(notificationId) {
  const q = readQueue();
  return q.find(n => n.notificationId === notificationId) || null;
}

/**
 * Retry all failed notifications immediately.
 */
export async function retryFailedNotifications() {
  const q = readQueue();
  q.forEach(n => {
    if (n.status === NOTIF_STATUS.FAILED && n.retryCount < MAX_RETRIES) {
      n.status      = NOTIF_STATUS.QUEUED;
      n.nextRetryAt = null;
    }
  });
  writeQueue(q);
  return processNotificationQueue();
}

/**
 * Get all notifications (optionally filtered by userId).
 */
export function getNotifications(userId) {
  const q = readQueue();
  return userId ? q.filter(n => n.userId === userId) : q;
}

/**
 * Get queue summary stats.
 */
export function getNotificationStats() {
  const q = readQueue();
  return {
    total:      q.length,
    queued:     q.filter(n => n.status === NOTIF_STATUS.QUEUED).length,
    delivering: q.filter(n => n.status === NOTIF_STATUS.DELIVERING).length,
    delivered:  q.filter(n => n.status === NOTIF_STATUS.DELIVERED).length,
    failed:     q.filter(n => n.status === NOTIF_STATUS.FAILED).length,
  };
}