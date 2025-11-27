/**
 * Join multiple URL segments into a single normalized URL
 */
export default function urlJoin(...parts: string[]): string {
    return parts
        .map((part, index) => {
            if (index === 0) return part.replace(/\/+$/, ''); // first part: trim trailing slash
            return part.replace(/^\/+|\/+$/g, ''); // middle parts: trim leading & trailing slash
        })
        .filter(Boolean)
        .join('/');
}
