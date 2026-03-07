import { PrismaClient } from '../generated/prisma/client.js';

export const prisma = globalThis.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
	globalThis.__prisma = prisma;
}
