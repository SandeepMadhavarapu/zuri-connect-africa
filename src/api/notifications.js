/**
 * Zuri Connect Africa — Notifications API Layer
 */

import * as NotifLib          from '@/lib/notifications';
import { obs }                from '@/lib/observability';

export async function sendSMS(userId, phone, message) {
  obs.info('notifications.sendSMS', { userId, phone });
  return NotifLib.sendNotification(NotifLib.NOTIF_TYPE.SMS, userId, { phone, message });
}

export async function sendPush(userId, title, body, data = {}) {
  obs.info('notifications.sendPush', { userId, title });
  return NotifLib.sendNotification(NotifLib.NOTIF_TYPE.PUSH, userId, { title, body, data });
}

export async function sendReceipt(userId, txRef, amount, recipient) {
  obs.info('notifications.sendReceipt', { userId, txRef, amount });
  return NotifLib.sendNotification(NotifLib.NOTIF_TYPE.RECEIPT, userId, { txRef, amount, recipient });
}

export function getNotifications(userId) {
  return NotifLib.getNotifications(userId);
}

export async function retryFailedNotifications() {
  obs.info('notifications.retryFailed');
  return NotifLib.retryFailedNotifications();
}