import type { Redis } from "ioredis";

export interface RateLimiter {
  /** true si todavia cabe otro mensaje dentro del limite. */
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

/**
 * Tope de mensajes por cliente por hora. Protege contra spam y contra una factura de IA
 * enorme provocada por alguien (o algo) que escribe sin parar.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const redisKey = `${this.prefix}:rl:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, windowSeconds);
    return count <= limit;
  }
}

export const unlimited: RateLimiter = { allow: async () => true };
