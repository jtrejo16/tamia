import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export interface Lock {
  /** Ejecuta `fn` con exclusion mutua por clave; espera su turno hasta `waitMs`. */
  withLock<T>(key: string, fn: () => Promise<T>, options?: { ttlMs?: number; waitMs?: number }): Promise<T>;
}

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`No se pudo obtener el candado "${key}" a tiempo`);
    this.name = "LockTimeoutError";
  }
}

// Solo borra el candado si sigue siendo el nuestro (no el de otro proceso que lo gano al expirar).
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Candado distribuido en Redis. Sirve para que dos mensajes seguidos del MISMO cliente se
 * procesen uno tras otro (si no, el agente podria responder dos veces o agendar doble).
 */
export class RedisLock implements Lock {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: { ttlMs?: number; waitMs?: number } = {},
  ): Promise<T> {
    const ttlMs = options.ttlMs ?? 180_000;
    const waitMs = options.waitMs ?? 120_000;
    const redisKey = `${this.prefix}:lock:${key}`;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;

    while ((await this.redis.set(redisKey, token, "PX", ttlMs, "NX")) !== "OK") {
      if (Date.now() >= deadline) throw new LockTimeoutError(key);
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE, 1, redisKey, token);
    }
  }
}

/** Sin exclusion: para pruebas unitarias de un solo hilo. */
export const noLock: Lock = { withLock: (_key, fn) => fn() };
