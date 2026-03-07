#!/usr/bin/env node
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

function parseArgs(argv) {
	const out = {};
	for (let i = 2; i < argv.length; i += 1) {
		const k = argv[i];
		const v = argv[i + 1];
		if (!k.startsWith('--')) continue;
		if (v && !v.startsWith('--')) {
			out[k.slice(2)] = v;
			i += 1;
		} else {
			out[k.slice(2)] = true;
		}
	}
	return out;
}

function usage() {
	console.log(`Usage:
  node scripts/resume-orphan-session.mjs --sessionId <uuid> --message "..." [--url ws://127.0.0.1:3001?role=client] [--agentId main] [--deliver false]
`);
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function main() {
	const args = parseArgs(process.argv);
	const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
	const message = typeof args.message === 'string' ? args.message.trim() : '';
	const wsUrl = typeof args.url === 'string' ? args.url : 'ws://127.0.0.1:3001?role=client';
	const agentId = typeof args.agentId === 'string' && args.agentId.trim() ? args.agentId.trim() : 'main';
	const deliver = String(args.deliver ?? 'false') === 'true';

	if (!sessionId || !message) {
		usage();
		process.exit(1);
	}

	const transcript = nodePath.join(os.homedir(), '.openclaw', 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
	if (!fs.existsSync(transcript)) {
		throw new Error(`Transcript not found: ${transcript}`);
	}

	const beforeSize = fs.statSync(transcript).size;
	const marker = `orphan-skill-marker-${Date.now()}`;
	const outboundMessage = `${message}\n\n[marker:${marker}]`;

	const ws = new WebSocket(wsUrl);
	const pending = new Map();
	let reqSeq = 1;
	let finalSeen = false;
	let lastAssistantText = null;

	function call(method, params, timeoutMs = 120000) {
		const id = `resume-${Date.now()}-${reqSeq++}`;
		const frame = { type: 'req', id, method, params };
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify(frame));
			setTimeout(() => {
				if (!pending.has(id)) return;
				pending.delete(id);
				reject(new Error(`timeout: ${method}`));
			}, timeoutMs);
		});
	}

	ws.on('message', (buf) => {
		const msg = JSON.parse(buf.toString());
		if (msg.type === 'res' && msg.id && pending.has(msg.id)) {
			const p = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.ok) p.resolve(msg);
			else p.reject(new Error(`${msg.error?.code ?? 'ERR'} ${msg.error?.message ?? 'request failed'}`));
			return;
		}
		if (msg.type === 'event' && msg.event === 'chat') {
			const data = msg.payload ?? {};
			if (data.state === 'final') {
				finalSeen = true;
				const chunks = data.message?.content ?? [];
				const textChunk = chunks.find((it) => it?.type === 'text');
				lastAssistantText = textChunk?.text ?? null;
			}
		}
	});

	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});

	const res = await call('agent', {
		sessionId,
		message: outboundMessage,
		idempotencyKey: `orphan-skill-${Date.now()}`,
		deliver,
	});

	const runId = res?.payload?.runId;
	for (let i = 0; i < 120; i += 1) {
		if (finalSeen) break;
		await wait(1000);
	}

	ws.close();

	const afterSize = fs.statSync(transcript).size;
	const tail = fs.readFileSync(transcript, 'utf8').slice(-8000);
	const markerFound = tail.includes(marker);

	console.log(JSON.stringify({
		ok: afterSize > beforeSize && markerFound,
		runId,
		sessionId,
		transcript,
		beforeSize,
		afterSize,
		grew: afterSize > beforeSize,
		markerFound,
		finalSeen,
		lastAssistantText,
	}, null, 2));
}

main().catch((err) => {
	console.error(String(err?.stack ?? err));
	process.exit(1);
});
