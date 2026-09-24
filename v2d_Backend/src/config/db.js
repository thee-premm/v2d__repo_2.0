import pkg from 'pg';
const { Pool } = pkg;
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export const pool = new Pool({
  host: env.DB.host,
  port: env.DB.port,
  database: env.DB.database,
  user: env.DB.user,
  password: env.DB.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  logger.debug('New client connected to PostgreSQL pool');
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Execute parameterized query with automatic pool management and logging
 */
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text: text.substring(0, 100), duration, rows: res.rowCount });
    return res;
  } catch (error) {
    logger.error('Database query error', { text, error: error.message });
    throw error;
  }
};

/**
 * Execute callback within an explicit ACID transaction (BEGIN / COMMIT / ROLLBACK)
 */
export const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back due to error', error);
    throw error;
  } finally {
    client.release();
  }
};
