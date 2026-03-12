import 'dotenv/config';
import { Command } from 'commander';
import confirm from '@inquirer/confirm';
import { prisma } from '../db/prisma.js';

const LEVEL_LABELS = {
	'-100': 'admin',
	'-1': 'dev',
	0: 'user',
	1: 'VIP',
	100: 'SVIP',
};

function labelOf(level) {
	return LEVEL_LABELS[level] ?? `custom(${level})`;
}

// --- 按 userId 或 loginName 查找用户 ---

async function resolveUser(identifier) {
	// 纯数字视为 userId
	if (/^\d+$/.test(identifier)) {
		const user = await prisma.user.findUnique({
			where: { id: BigInt(identifier) },
			include: { localAuth: { select: { loginName: true } } },
		});
		return user;
	}
	// 否则按 loginName 查找
	const localAuth = await prisma.localAuth.findUnique({
		where: { loginName: identifier },
		include: {
			user: {
				include: { localAuth: { select: { loginName: true } } },
			},
		},
	});
	return localAuth?.user ?? null;
}

// --- 子命令实现 ---

async function userCount() {
	const count = await prisma.user.count();
	console.log(`用户总数: ${count}`);
}

async function userList() {
	const users = await prisma.user.findMany({
		include: { localAuth: { select: { loginName: true } } },
		orderBy: { createdAt: 'asc' },
	});
	if (users.length === 0) {
		console.log('暂无用户');
		return;
	}
	console.table(users.map((u) => ({
		id: u.id.toString(),
		loginName: u.localAuth?.loginName ?? '-',
		name: u.name ?? '-',
		level: `${u.level} (${labelOf(u.level)})`,
		locked: u.locked,
		createdAt: u.createdAt.toISOString(),
		lastLoginAt: u.lastLoginAt?.toISOString() ?? '-',
	})));
}

async function userSetLevel(identifier, levelStr) {
	const level = Number(levelStr);
	if (!Number.isInteger(level)) {
		console.error(`无效的 level 值: ${levelStr}`);
		process.exitCode = 1;
		return;
	}

	const user = await resolveUser(identifier);
	if (!user) {
		console.error(`未找到用户: ${identifier}`);
		process.exitCode = 1;
		return;
	}

	const userId = user.id.toString();
	const loginName = user.localAuth?.loginName ?? '-';
	console.log(`用户: ${loginName} (id=${userId})`);
	console.log(`当前 level: ${user.level} (${labelOf(user.level)})`);
	console.log(`目标 level: ${level} (${labelOf(level)})`);

	if (user.level === level) {
		console.log('level 未变化，跳过');
		return;
	}

	const yes = await confirm({ message: '确认修改？' });
	if (!yes) {
		console.log('已取消');
		return;
	}

	await prisma.user.update({
		where: { id: user.id },
		data: { level },
	});
	console.log('已更新');
}

async function userSetAllLevel(levelStr) {
	const level = Number(levelStr);
	if (!Number.isInteger(level)) {
		console.error(`无效的 level 值: ${levelStr}`);
		process.exitCode = 1;
		return;
	}

	const count = await prisma.user.count();
	console.log(`即将把所有 ${count} 个用户的 level 设置为: ${level} (${labelOf(level)})`);

	const yes1 = await confirm({ message: `确认将全部 ${count} 个用户的 level 设为 ${level}？` });
	if (!yes1) {
		console.log('已取消');
		return;
	}

	const yes2 = await confirm({ message: '此操作不可撤销，再次确认？', default: false });
	if (!yes2) {
		console.log('已取消');
		return;
	}

	const result = await prisma.user.updateMany({ data: { level } });
	console.log(`已更新 ${result.count} 个用户`);
}

// --- CLI 定义 ---

const program = new Command();
program.name('admin').description('CoClaw admin CLI');

const user = program.command('user').description('用户管理');

user.command('count')
	.description('查询用户总数')
	.action(userCount);

user.command('list')
	.description('列出所有用户基本信息')
	.action(userList);

user.command('set-level')
	.description('设置用户 level')
	.argument('<identifier>', '用户 ID 或 loginName')
	.argument('<level>', '目标 level 值')
	.action(userSetLevel);

user.command('set-all-level')
	.description('将所有用户的 level 设为指定值（需两次确认）')
	.argument('<level>', '目标 level 值')
	.action(userSetAllLevel);

program.parseAsync(process.argv)
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
