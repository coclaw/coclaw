async function requestJson(baseUrl, path, { method = 'GET', headers, body, timeout } = {}) {
	const url = new URL(path, baseUrl).toString();
	const fetchOpts = {
		method,
		headers,
		body: body == null ? undefined : JSON.stringify(body),
	};
	if (timeout) {
		fetchOpts.signal = AbortSignal.timeout(timeout);
	}
	const res = await fetch(url, fetchOpts);
	let data = null;
	try {
		data = await res.json();
	}
	/* c8 ignore next 3 */
	catch {
		data = null;
	}
	if (!res.ok) {
		const err = new Error(data?.message || `HTTP ${res.status}`);
		err.response = { status: res.status, data };
		throw err;
	}
	return data;
}

const BIND_TIMEOUT = 30_000;
const UNBIND_TIMEOUT = 15_000;

export async function bindWithServer({ baseUrl, code, name }) {
	return requestJson(baseUrl, '/api/v1/bots/bind', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: { code, name },
		timeout: BIND_TIMEOUT,
	});
}

export async function unbindWithServer({ baseUrl, token, timeout = UNBIND_TIMEOUT }) {
	return requestJson(baseUrl, '/api/v1/bots/unbind', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
		},
		timeout,
	});
}

