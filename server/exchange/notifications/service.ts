/**
 * User Notifications Service
 * Handles writing and reading trade/order notifications for users.
 */

import { desc, eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import { userNotifications } from "../../../drizzle/schema";

export async function createNotification(params: {
  userId: number;
  type: string;
  title: string;
  body: string;
  refTable?: string;
  refId?: number;
}) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(userNotifications).values({
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      refTable: params.refTable,
      refId: params.refId,
    });
  } catch (e) {
    // Non-critical: log but don't throw
    console.error("[notifications] Failed to create notification:", e);
  }
}

export async function getUserNotifications(userId: number, limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(userNotifications)
    .where(eq(userNotifications.userId, userId))
    .orderBy(desc(userNotifications.createdAt))
    .limit(limit);
}

export async function getUnreadCount(userId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select()
    .from(userNotifications)
    .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)));
  return rows.length;
}

export async function markNotificationsRead(userId: number, ids?: number[]) {
  const db = await getDb();
  if (!db) return;
  if (ids && ids.length > 0) {
    // Mark specific notifications as read
    for (const id of ids) {
      await db
        .update(userNotifications)
        .set({ isRead: true })
        .where(and(eq(userNotifications.id, id), eq(userNotifications.userId, userId)));
    }
  } else {
    // Mark all as read
    await db
      .update(userNotifications)
      .set({ isRead: true })
      .where(eq(userNotifications.userId, userId));
  }
}
