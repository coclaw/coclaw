#!/usr/bin/env node
// 续写 orphan session：connect 握手 → agent(sessionId) → 等终态 → 验证 transcript 增长与 marker。
// 协议要点（与 plugins/openclaw/src/realtime-bridge.js 保持同步）：
//   - 网关第一帧必须是 connect（否则 INVALID_REQUEST + close 1008）
//   - 默认 token 鉴权、loopback 不豁免；token 解析 config-first：--token > 配置 gateway.auth.token > env OPENCLAW_GATEWAY_TOKEN
//   - agent 是两阶段响应：accepted 是中间态（拿 runId），同 id 下一帧才是终态（ok=false 即失败）
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ws 装在 workspace 包下（根 node_modules 没有），从 server/ui/plugin 任一处解析
const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../../..');
function loadWebSocket() {
	for (const rel of ['server', 'ui', 'plugins/openclaw']) {
		try {
			return createRequire(nodePath.join(repoRoot, rel, 'package.json'))('ws');
		} catch {}
	}
	throw new Error('cannot resolve "ws" from workspace packages; run pnpm install at repo root first');
}
const WebSocket = loadWebSocket();

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
  node scripts/resume-orphan-session.mjs --sessionId <uuid> --message "..." \\
    [--url ws://127.0.0.1:18789] [--token <gateway-token>] [--agentId main] [--deliver false] [--timeoutSec 300]

  --token 省略时依次取 OpenClaw 配置 gateway.auth.token（$OPENCLAW_CONFIG_PATH 或 <state-dir>/openclaw.json）、
  env OPENCLAW_GATEWAY_TOKEN（config-first，同上游顺序）。配置侧只支持"严格 JSON + 字符串 token"
  的常见形态；JSON5 写法或 SecretRef token 读不出会打警告回退 env，此时请显式传 --token
`);
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function resolveStateDir() {
	const dir = process.env.OPENCLAW_STATE_DIR;
	return dir && dir.trim() ? dir.trim() : nodePath.join(os.homedir(), '.openclaw');
}

function resolveConfigPath() {
	const explicit = process.env.OPENCLAW_CONFIG_PATH;
	return explicit && explicit.trim() ? explicit.trim() : nodePath.join(resolveStateDir(), 'openclaw.json');
}

// token 解析：配置 gateway.auth.token 优先、env 兜底（同上游 auth-resolve 的 config-first
// 与插件 defaultResolveGatewayAuthToken 的顺序；env 残留旧 token 时不至压过配置里的新 token）。
// 注意：上游配置读取支持 JSON5、token 可为 SecretRef 对象（src/config/io.ts parseConfigJson5 /
// types.secrets.ts SecretInput）——本脚本只处理"严格 JSON + 字符串 token"的常见形态，
// 不为边角引 JSON5 解析依赖；读不出时打警告回退 env，特殊形态请显式传 --token。
function resolveGatewayToken() {
	const cfgPath = resolveConfigPath();
	try {
		const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
		const t = cfg?.gateway?.auth?.token;
		if (typeof t === 'string' && t.trim()) return t.trim();
		if (t !== undefined && typeof t !== 'string') {
			console.error(`[resume] gateway.auth.token in ${cfgPath} is not a plain string (SecretRef?); falling back to env, pass --token explicitly if needed`);
		}
	} catch {
		if (fs.existsSync(cfgPath)) {
			console.error(`[resume] cannot parse ${cfgPath} as strict JSON (JSON5 syntax?); falling back to env, pass --token explicitly if needed`);
		}
	}
	const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
	return envToken && envToken.trim() ? envToken.trim() : '';
}

// 裸名不在时列出归档变体（.reset.<ts> / .deleted.<ts>），避免误判"正文彻底没了"
function listArchiveVariants(dir, sessionId) {
	try {
		return fs.readdirSync(dir).filter((f) => f.startsWith(`${sessionId}.jsonl.`)).sort();
	} catch {
		return [];
	}
}

async function main() {
	const args = parseArgs(process.argv);
	const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
	const message = typeof args.message === 'string' ? args.message.trim() : '';
	const wsUrl = typeof args.url === 'string' ? args.url : 'ws://127.0.0.1:18789';
	const agentId = typeof args.agentId === 'string' && args.agentId.trim() ? args.agentId.trim() : 'main';
	const deliver = String(args.deliver ?? 'false') === 'true';
	const timeoutSec = Number(args.timeoutSec) > 0 ? Number(args.timeoutSec) : 300;
	const token = typeof args.token === 'string' && args.token.trim() ? args.token.trim() : resolveGatewayToken();

	if (!sessionId || !message) {
		usage();
		process.exit(1);
	}

	const sessionsDir = nodePath.join(resolveStateDir(), 'agents', agentId, 'sessions');
	const transcript = nodePath.join(sessionsDir, `${sessionId}.jsonl`);
	if (!fs.existsSync(transcript)) {
		const variants = listArchiveVariants(sessionsDir, sessionId);
		const hint = variants.length
			? `archive variants exist (${variants.join(', ')}); this script does not resume archived transcripts`
			: 'no archive variants found either; transcript may have been purged by retention';
		throw new Error(`Active transcript not found: ${transcript}\n  ${hint}`);
	}

	const beforeSize = fs.statSync(transcript).size;
	const marker = `orphan-skill-marker-${Date.now()}`;
	const outboundMessage = `${message}\n\n[marker:${marker}]`;

	const ws = new WebSocket(wsUrl);
	const pending = new Map();
	let reqSeq = 1;
	let finalSeen = false; // chat 事件 state==='final'
	let chatError = null; // chat 事件 state==='error' 的 errorMessage
	let lastAssistantText = null;

	// 单个 req 的响应等待。传 onAccepted 即镜像两阶段语义（同 gateway-agent-rpc skill）：
	// status==='accepted' 只调回调、保留 waiter，同 id 下一帧才是终态。
	function call(method, params, { timeoutMs = 120000, onAccepted } = {}) {
		const id = `resume-${Date.now()}-${reqSeq++}`;
		const frame = { type: 'req', id, method, params };
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, onAccepted });
			ws.send(JSON.stringify(frame));
			setTimeout(() => {
				if (!pending.has(id)) return;
				pending.delete(id);
				reject(new Error(`timeout waiting response: ${method}`));
			}, timeoutMs);
		});
	}

	ws.on('message', (buf) => {
		let msg;
		try {
			msg = JSON.parse(buf.toString());
		} catch {
			return; // 忽略非 JSON 帧，避免握手被拒等场景崩在解析栈上
		}
		if (msg.type === 'res' && msg.id && pending.has(msg.id)) {
			const p = pending.get(msg.id);
			if (p.onAccepted && msg.ok && msg.payload?.status === 'accepted') {
				p.onAccepted(msg.payload); // 中间态：保留 waiter 等同 id 终态帧
				return;
			}
			pending.delete(msg.id);
			if (msg.ok) p.resolve(msg);
			else p.reject(new Error(`${msg.error?.code ?? 'ERR'} ${msg.error?.message ?? 'request failed'}`));
			return;
		}
		if (msg.type === 'event' && msg.event === 'chat') {
			const data = msg.payload ?? {};
			// chat 事件终态只有 final / error（上游无 state==='aborted'）
			if (data.state === 'final') {
				finalSeen = true;
				const chunks = data.message?.content ?? [];
				const textChunk = chunks.find((it) => it?.type === 'text');
				lastAssistantText = textChunk?.text ?? null;
			} else if (data.state === 'error') {
				chatError = data.errorMessage ?? 'chat error';
			}
		}
	});

	await new Promise((resolve, reject) => {
		ws.once('open', resolve);
		ws.once('error', reject);
	});

	// 第一帧必须是 connect 握手。形状镜像 plugins/openclaw/src/realtime-bridge.js 的
	// legacy 路径（无 device 字段——operator + 共享 token 可跳过设备身份，已实测）；
	// 协议范围与插件保持同步，插件升号时这里跟着改。
	await call('connect', {
		minProtocol: 3,
		maxProtocol: 4,
		client: { id: 'gateway-client', version: 'orphan-resume-script', platform: process.platform, mode: 'backend' },
		caps: ['tool-events'],
		role: 'operator',
		scopes: ['operator.admin'],
		auth: token ? { token } : undefined,
	}, { timeoutMs: 15000 });

	// agent 两阶段：accepted 拿 runId（中间态），同 id final 帧才是结果
	let acceptedPayload = null;
	let finalRes = null;
	let agentErr = null; // final ok=false 或等待超时：不中断，落盘验证照做、结果里报告
	try {
		finalRes = await call('agent', {
			agentId, // 显式传给网关，避免网关落到默认 agent 而与本地 transcript 路径错位
			sessionId,
			message: outboundMessage,
			idempotencyKey: `orphan-skill-${Date.now()}`,
			deliver,
		}, { timeoutMs: timeoutSec * 1000, onAccepted: (p) => { acceptedPayload = p; } });
	} catch (err) {
		agentErr = err;
	}

	const runId = acceptedPayload?.runId ?? finalRes?.payload?.runId ?? null;

	// 等 chat 终态事件补齐 assistant 文本；final 帧已到（或已失败）则最多再等 10s
	for (let i = 0; i < timeoutSec; i += 1) {
		if (finalSeen || chatError) break;
		if ((finalRes || agentErr) && i >= 10) break;
		await wait(1000);
	}

	ws.close();

	const afterSize = fs.statSync(transcript).size;
	const tail = fs.readFileSync(transcript, 'utf8').slice(-8000);
	const markerFound = tail.includes(marker);

	console.log(JSON.stringify({
		ok: afterSize > beforeSize && markerFound && !agentErr && !chatError,
		runId,
		sessionId,
		transcript,
		beforeSize,
		afterSize,
		grew: afterSize > beforeSize,
		markerFound,
		acceptedSeen: Boolean(acceptedPayload),
		finalStatus: finalRes?.payload?.status ?? null,
		finalSeen,
		chatError,
		agentError: agentErr ? String(agentErr.message ?? agentErr) : null,
		lastAssistantText,
	}, null, 2));
}

main().catch((err) => {
	console.error(String(err?.stack ?? err));
	process.exit(1);
});
