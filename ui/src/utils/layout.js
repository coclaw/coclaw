export function isMobileViewport(width) {
	if (typeof width !== 'number') {
		return false;
	}
	return width <= 767;
}

export function getAuthedHomeRoute(width) {
	return isMobileViewport(width) ? '/topics' : '/home';
}
