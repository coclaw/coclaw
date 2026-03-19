import http from 'node:http';

export async function createMockServer() {
	const state = {
		bound: false,
		token: 'mock-token-1',
		botId: '9001',
	};

	const server = http.createServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/api/v1/bots/bind') {
			let body = '';
			for await (const chunk of req) {
				body += chunk;
			}
			/* c8 ignore next */
			const data = JSON.parse(body || '{}');
			if (!data.code) {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ code: 'INVALID_INPUT', message: 'code required' }));
				return;
			}
			state.bound = true;
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: state.botId, token: state.token, rebound: false }));
			return;
		}

		if (req.method === 'POST' && req.url === '/api/v1/claws/claim-codes') {
			res.writeHead(201, { 'content-type': 'application/json' });
			res.end(JSON.stringify({
				code: '88887777',
				expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
				waitToken: 'mock-wait-token',
			}));
			return;
		}

		if (req.method === 'POST' && req.url === '/api/v1/claws/claim-codes/wait') {
			// 模拟立即返回 BOUND
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({
				botId: state.botId,
				token: state.token,
			}));
			return;
		}

		if (req.method === 'POST' && req.url === '/api/v1/bots/unbind') {
			const auth = req.headers.authorization;
			if (auth !== `Bearer ${state.token}`) {
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'bad token' }));
				return;
			}
			state.bound = false;
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ botId: state.botId, status: 'inactive' }));
			return;
		}

		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ code: 'NOT_FOUND' }));
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;

	return {
		baseUrl,
		state,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
