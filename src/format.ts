export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) {
		return `${hours}h ${pad(minutes)}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${pad(seconds)}s`;
	}
	return `${seconds}s`;
}

export function formatClock(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${pad(seconds)}`;
}

/** Wall-clock time of day in the user's locale, e.g. "12:25 PM". */
export function formatTimeOfDay(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}
