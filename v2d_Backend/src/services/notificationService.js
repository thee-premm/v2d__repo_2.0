import { query, withTransaction } from "../config/db.js";
import { logger } from "../utils/logger.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mock FCM / SMS Provider Dispatcher
 */
const mockProviderDispatch = async (
  channel,
  recipientInfo,
  messageContent,
  shouldFail = false,
) => {
  const start = Date.now();
  // Simulate realistic network latency (15-35ms)
  await delay(20);
  const latencyMs = Date.now() - start;

  if (shouldFail) {
    throw new Error(
      `Provider Connection Timeout (${channel} Gateway Error 504)`,
    );
  }

  const messageId = `${channel.toLowerCase()}_msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  return {
    success: true,
    providerMessageId: messageId,
    latencyMs,
    channel,
    timestamp: new Date().toISOString(),
  };
};

export const notificationService = {
  /**
   * Queue a single notification in database
   */
  async queueNotification({
    userId,
    type,
    channel = "PUSH",
    metadata = {},
    forceFailure = false,
  }) {
    const metaObj = { ...metadata, forceFailure };
    const insertSql = `
      INSERT INTO notification_logs (user_id, type, channel, status, retry_count, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, 'QUEUED', 0, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *;
    `;
    const res = await query(insertSql, [
      userId,
      type,
      channel,
      JSON.stringify(metaObj),
    ]);
    const notification = res.rows[0];
    logger.info(
      `[NotificationQueue] Notification #${notification.id} queued for User #${userId} [${type} via ${channel}]`,
    );
    return notification;
  },

  /**
   * Dispatch a notification immediately or via worker with exponential backoff
   */
  async dispatchNotification(notificationId) {
    const notifRes = await query(
      `SELECT n.*, u.email, u.username FROM notification_logs n JOIN users u ON n.user_id = u.id WHERE n.id = $1`,
      [notificationId],
    );
    if (notifRes.rows.length === 0) {
      throw {
        statusCode: 404,
        message: `Notification #${notificationId} not found`,
      };
    }

    const notif = notifRes.rows[0];
    const meta =
      typeof notif.metadata === "string"
        ? JSON.parse(notif.metadata)
        : notif.metadata || {};
    const shouldFail = meta.forceFailure && notif.retry_count < 2; // Test fail then succeed on 2nd retry if forceFailure

    try {
      logger.info(
        `[NotificationDispatcher] Attempting delivery for #${notif.id} (${notif.type} to ${notif.username} via ${notif.channel}) [Attempt ${notif.retry_count + 1}]...`,
      );
      const providerRes = await mockProviderDispatch(
        notif.channel,
        notif.email,
        meta.message || notif.type,
        shouldFail,
      );

      // Update as DELIVERED
      const updatedMeta = {
        ...meta,
        providerResponse: providerRes,
        deliveredAt: new Date().toISOString(),
      };
      const updateRes = await query(
        `UPDATE notification_logs 
         SET status = 'DELIVERED', metadata = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 RETURNING *;`,
        [JSON.stringify(updatedMeta), notif.id],
      );

      logger.info(
        `✅ [NotificationDispatcher] #${notif.id} DELIVERED successfully via ${notif.channel} (${providerRes.latencyMs}ms latency)`,
      );
      return { success: true, notification: updateRes.rows[0] };
    } catch (err) {
      const nextRetry = notif.retry_count + 1;
      const backoffDelay = Math.pow(2, nextRetry) * 100; // exponential backoff (e.g. 200ms, 400ms, 800ms)
      logger.warn(
        `⚠️ [NotificationDispatcher] Delivery failed for #${notif.id}: ${err.message}. Backoff: ${backoffDelay}ms (Retry ${nextRetry}/3)`,
      );

      if (nextRetry < 3) {
        // Schedule / Execute backoff retry
        await delay(Math.min(backoffDelay, 500)); // cap simulated wait
        await query(
          `UPDATE notification_logs 
           SET retry_count = $1, status = 'QUEUED', updated_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [nextRetry, notif.id],
        );
        // Recursive retry attempt
        return await this.dispatchNotification(notif.id);
      } else {
        // Mark FAILED
        const failedMeta = {
          ...meta,
          lastError: err.message,
          failedAt: new Date().toISOString(),
        };
        const failRes = await query(
          `UPDATE notification_logs 
           SET status = 'FAILED', retry_count = $1, metadata = $2, updated_at = CURRENT_TIMESTAMP 
           WHERE id = $3 RETURNING *;`,
          [nextRetry, JSON.stringify(failedMeta), notif.id],
        );
        logger.error(
          `❌ [NotificationDispatcher] #${notif.id} permanently FAILED after ${nextRetry} attempts.`,
        );
        return { success: false, notification: failRes.rows[0] };
      }
    }
  },

  /**
   * Worker to process all queued notifications in batches
   */
  async processQueue(batchSize = 25) {
    const queuedRes = await query(
      `SELECT id FROM notification_logs 
       WHERE status = 'QUEUED' AND retry_count < 3 
       ORDER BY created_at ASC 
       LIMIT $1`,
      [batchSize],
    );

    const results = [];
    for (const row of queuedRes.rows) {
      const res = await this.dispatchNotification(row.id);
      results.push(res);
    }
    return {
      processedCount: results.length,
      results,
    };
  },

  /**
   * Trigger 1: PRE_VOTE_REMINDER when a meal slot opens
   */
  async triggerPreVoteReminders(mealSlotId) {
    const slotRes = await query(
      `SELECT ms.*, mt.name AS meal_type_name, m.name AS mess_name 
       FROM meal_slots ms 
       JOIN meal_types mt ON ms.meal_type_id = mt.id 
       JOIN messes m ON ms.mess_id = m.id 
       WHERE ms.id = $1`,
      [mealSlotId],
    );

    if (slotRes.rows.length === 0) {
      throw { statusCode: 404, message: `Meal slot #${mealSlotId} not found` };
    }
    const slot = slotRes.rows[0];

    // Find all enrolled students in this mess
    const studentsRes = await query(
      `SELECT s.id AS student_id, s.user_id, s.name, s.roll_number, u.email 
       FROM students s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.mess_id = $1 AND s.enrolled = TRUE`,
      [slot.mess_id],
    );

    const queuedList = [];
    for (const st of studentsRes.rows) {
      const notif = await this.queueNotification({
        userId: st.user_id,
        type: "PRE_VOTE_REMINDER",
        channel: "PUSH",
        metadata: {
          mealSlotId: slot.id,
          mealType: slot.meal_type_name,
          messName: slot.mess_name,
          cutoffTime: slot.cutoff_time,
          message: `Voting is now OPEN for ${slot.meal_type_name} at ${slot.mess_name}. Cast your attendance vote before ${new Date(slot.cutoff_time).toLocaleTimeString()}!`,
        },
      });
      queuedList.push(notif);
    }

    return {
      mealSlotId,
      dispatchedCount: queuedList.length,
      notifications: queuedList,
    };
  },

  /**
   * Trigger 2: CLOSING_ALERT before cutoff (e.g., 30 mins prior to unvoted students)
   */
  async triggerClosingAlerts(mealSlotId, minutesRemaining = 30) {
    const slotRes = await query(
      `SELECT ms.*, mt.name AS meal_type_name, m.name AS mess_name 
       FROM meal_slots ms 
       JOIN meal_types mt ON ms.meal_type_id = mt.id 
       JOIN messes m ON ms.mess_id = m.id 
       WHERE ms.id = $1`,
      [mealSlotId],
    );

    if (slotRes.rows.length === 0) {
      throw { statusCode: 404, message: `Meal slot #${mealSlotId} not found` };
    }
    const slot = slotRes.rows[0];

    // Find students in this mess who have NOT yet voted for this slot
    const unvotedStudentsRes = await query(
      `SELECT s.id AS student_id, s.user_id, s.name, s.roll_number 
       FROM students s 
       WHERE s.mess_id = $1 
         AND s.enrolled = TRUE 
         AND s.id NOT IN (
           SELECT student_id FROM votes WHERE meal_slot_id = $2
         )`,
      [slot.mess_id, mealSlotId],
    );

    const queuedList = [];
    for (const st of unvotedStudentsRes.rows) {
      const notif = await this.queueNotification({
        userId: st.user_id,
        type: "CLOSING_ALERT",
        channel: "SMS",
        metadata: {
          mealSlotId: slot.id,
          mealType: slot.meal_type_name,
          minutesRemaining,
          cutoffTime: slot.cutoff_time,
          message: `URGENT: ${minutesRemaining} minutes left before ${slot.meal_type_name} voting closes! Confirm YES or NO now to prevent unvoted queue delays.`,
        },
      });
      queuedList.push(notif);
    }

    return {
      mealSlotId,
      unvotedCount: unvotedStudentsRes.rows.length,
      notifications: queuedList,
    };
  },

  /**
   * Trigger 3: POST_MEAL_CONFIRMATION when counter attendance is scanned
   */
  async triggerPostMealConfirmation(studentId, mealSlotId, verificationStatus) {
    const studentRes = await query(
      `SELECT s.id, s.user_id, s.name, s.roll_number, ms.slot_date, mt.name AS meal_type_name 
       FROM students s 
       JOIN meal_slots ms ON ms.id = $2 
       JOIN meal_types mt ON ms.meal_type_id = mt.id 
       WHERE s.id = $1`,
      [studentId, mealSlotId],
    );

    if (studentRes.rows.length === 0) return null;
    const info = studentRes.rows[0];

    const notif = await this.queueNotification({
      userId: info.user_id,
      type: "POST_MEAL_CONFIRMATION",
      channel: "PUSH",
      metadata: {
        mealSlotId,
        mealType: info.meal_type_name,
        verificationStatus,
        message: `Meal entry verified: [${verificationStatus}] for ${info.meal_type_name}. Enjoy your meal!`,
      },
    });

    // Auto-dispatch directly in background
    this.dispatchNotification(notif.id).catch((err) => {
      logger.warn(`Async background dispatch warning: ${err.message}`);
    });

    return notif;
  },

  /**
   * Query notification history logs
   */
  async getNotificationLogs({ userId, type, status, limit = 50 }) {
    let sql = `
      SELECT nl.*, u.username, u.email 
      FROM notification_logs nl 
      JOIN users u ON nl.user_id = u.id 
      WHERE 1=1
    `;
    const params = [];

    if (userId) {
      params.push(userId);
      sql += ` AND nl.user_id = $${params.length}`;
    }
    if (type) {
      params.push(type);
      sql += ` AND nl.type = $${params.length}`;
    }
    if (status) {
      params.push(status);
      sql += ` AND nl.status = $${params.length}`;
    }

    params.push(limit);
    sql += ` ORDER BY nl.created_at DESC LIMIT $${params.length}`;

    const res = await query(sql, params);
    return res.rows;
  },
};
