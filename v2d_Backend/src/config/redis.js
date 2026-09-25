import Redis from "ioredis";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

export const redis = new Redis({
  host: env.REDIS.host,
  port: env.REDIS.port,
  password: env.REDIS.password || undefined,
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    if (times > 2) return null; // stop retrying if redis server is offline
    return 1000;
  },
});

redis.on("connect", () => {
  logger.info("Connected to Redis server");
});

redis.on("error", (err) => {
  logger.warn(`Redis connection notice: ${err.message}`);
});

export const connectRedis = async () => {
  try {
    await redis.connect();
    logger.info("Redis client initialized");
  } catch (err) {
    logger.warn(
      `Redis client offline - system using database write-through mode (${err.message})`,
    );
  }
};
