import { spawn } from 'node:child_process';

function makeDefaultName() {
	const now = new Date();
	const pad = (v) => String(v).padStart(2, '0');
	const yyyy = now.getFullYear();
	const mm = pad(now.getMonth() + 1);
	const dd = pad(now.getDate());
	const hh = pad(now.getHours());
	const mi = pad(now.getMinutes());
	const ss = pad(now.getSeconds());
	return `migration_${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function parseCliArgs(argv) {
	const args = [...argv];
	let hasName = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '--name' || arg === '-n') {
			hasName = true;
			i += 1;
			continue;
		}
		if (arg.startsWith('--name=')) {
			hasName = true;
		}
	}

	return {
		hasName,
		args,
	};
}

function run() {
	const { hasName, args } = parseCliArgs(process.argv.slice(2));
	const migrateArgs = ['exec', 'prisma', 'migrate', 'dev'];

	if (hasName) {
		migrateArgs.push(...args);
	}
	else {
		migrateArgs.push('--name', makeDefaultName(), ...args);
	}

	const child = spawn('pnpm', migrateArgs, {
		stdio: 'inherit',
		env: process.env,
	});

	child.on('exit', (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
}

run();
