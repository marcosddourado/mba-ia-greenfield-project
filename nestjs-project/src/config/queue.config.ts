import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  // Redis connection for BullMQ. Reached via the Compose service name `redis`
  // (per phase-03-videos/TD-02).
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
}));
