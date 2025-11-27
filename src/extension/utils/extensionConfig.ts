/**
 * Minimal placeholder config for Live Server++
 */

interface ExtensionConfig {
    port: number;
    browser: string | null;
    root: string;
    timeout: number;
    indexFile: string;
    reloadingStrategy: 'hot' | 'partial-reload' | 'reload';
}

const defaultConfig: ExtensionConfig = {
    port: 5555,
    browser: 'default',
    root: './',
    timeout: 300,
    indexFile: 'index.html',
    reloadingStrategy: 'hot'
};

export default defaultConfig;
export type { ExtensionConfig };
