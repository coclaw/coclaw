import { execSync } from 'node:child_process';

export default async function globalSetup() {
	execSync('pnpm --filter @coclaw/server account:create-test-local', {
		stdio: 'inherit',
	});
}
