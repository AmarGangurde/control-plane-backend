import { AsyncLocalStorage } from 'async_hooks';

// Shared store for per-request context (requestId, userId, etc.)
export const requestContext = new AsyncLocalStorage();

const isProd = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'PROD';

const formatArgs = (args) => {
	const parts = [];
	let extra = {};
	for (const arg of args) {
		if (arg instanceof Error) {
			extra = { ...extra, err: arg.message, stack: arg.stack };
		} else if (arg && typeof arg === 'object') {
			extra = { ...extra, ...arg };
		} else {
			parts.push(arg);
		}
	}
	return { msg: parts.join(' '), extra };
};

const log = (level, args) => {
	const ts = new Date().toISOString();
	const ctx = requestContext.getStore() || {};
	const { msg, extra } = formatArgs(args);

	if (isProd) {
		const entry = { ts, level, ...ctx, msg, ...extra };
		(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(
			JSON.stringify(entry)
		);
	} else {
		const prefix = `${ts} [${level.toUpperCase()}]${ctx.requestId ? ` [${ctx.requestId}]` : ''}`;
		const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
		if (Object.keys(extra).length) {
			fn(prefix, msg, extra);
		} else {
			fn(prefix, msg);
		}
	}
};

const logger = {
	info: (...args) => log('info', args),
	warn: (...args) => log('warn', args),
	error: (...args) => log('error', args),
};

export default logger;
