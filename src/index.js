/**
 * @krusch/polygres-connector
 * Standalone plugin & connector toolkit bridging KruschContext and KruschGit
 * with Polygres Cloud and Wondersearch.
 */

export { loadConfig } from './config.js';
export { ContextBridge } from './context-bridge.js';
export { GitBridge } from './git-bridge.js';
export { WondersearchBridge } from './wondersearch-bridge.js';

import { loadConfig } from './config.js';
import { ContextBridge } from './context-bridge.js';
import { GitBridge } from './git-bridge.js';
import { WondersearchBridge } from './wondersearch-bridge.js';

/**
 * Convenience factory to create a fully configured connector instance
 */
export function createPolygresConnector(options = {}) {
  const config = loadConfig(options);
  const context = new ContextBridge(config);
  const git = new GitBridge(config);
  const wondersearch = new WondersearchBridge(config);

  return {
    config,
    context,
    git,
    wondersearch,
    async close() {
      await context.close();
      await git.close();
      await wondersearch.close();
    }
  };
}
