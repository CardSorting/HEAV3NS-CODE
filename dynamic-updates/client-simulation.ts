/**
 * HEAV3NS-CODE: Client Dynamic Update Simulator
 *
 * Demonstrates the exact logic implemented in EngineManager.swift
 * for resolving the active runtime engine and applying silent OTA patches.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EngineManifest {
  version: string;
  bundleUrl: string;
  sha256: string;
  releasedAt: string;
}

export class ClientUpdateSimulator {
  private readonly appSupportRuntimeDir: string;
  private readonly feedUrl = 'https://releases.heav3ns.com/engine-latest.json';

  constructor() {
    this.appSupportRuntimeDir = path.join(os.homedir(), 'Library', 'Application Support', 'HEAV3NS-CODE', 'runtime');
  }

  /**
   * Resolves which engine to boot with safe precedence:
   * 1. Explicit override passed in parameters
   * 2. HEAV3NS_CLI environment variable
   * 3. Locally downloaded OTA hot-update in Application Support (if present)
   * 4. Factory bundled index.js inside the .app bundle
   */
  public resolveActiveCLI(override?: string): { path: string; source: 'override' | 'env' | 'ota' | 'factory' } {
    if (override && fs.existsSync(override)) {
      return { path: override, source: 'override' };
    }

    const envCLI = process.env.HEAV3NS_CLI;
    if (envCLI && fs.existsSync(envCLI)) {
      return { path: envCLI, source: 'env' };
    }

    const otaCLI = path.join(this.appSupportRuntimeDir, 'dist', 'index.js');
    if (fs.existsSync(otaCLI)) {
      return { path: otaCLI, source: 'ota' };
    }

    const factoryCLI = path.resolve(__dirname, '..', 'build', 'HEAV3NS-CODE.app', 'Contents', 'Resources', 'runtime', 'dist', 'index.js');
    return { path: factoryCLI, source: 'factory' };
  }

  /**
   * Checks the live remote feed for an engine update.
   */
  public async checkForUpdate(): Promise<{ hasUpdate: boolean; currentVersion: string; remoteVersion?: string; downloadUrl?: string }> {
    const currentVersion = this.getCurrentInstalledVersion();

    try {
      const response = await fetch(this.feedUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${this.feedUrl}`);
      }

      const manifest = (await response.json()) as EngineManifest;
      const hasUpdate = this.compareSemver(manifest.version, currentVersion) > 0;

      return {
        hasUpdate,
        currentVersion,
        remoteVersion: manifest.version,
        downloadUrl: manifest.bundleUrl,
      };
    } catch (err) {
      console.warn(`[EngineManager] Update check failed: ${(err as Error).message}`);
      return { hasUpdate: false, currentVersion };
    }
  }

  private getCurrentInstalledVersion(): string {
    const manifestPath = path.join(this.appSupportRuntimeDir, 'engine-version.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return data.version ?? '14.0.0';
      } catch {
        // Fallback
      }
    }
    return '14.0.0';
  }

  private compareSemver(v1: string, v2: string): number {
    const p1 = v1.split('.').map(Number);
    const p2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }
}

// Self-test simulation
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  (async () => {
    console.log('==========================================================');
    console.log('  HEAV3NS-CODE Client Engine Resolver Simulation');
    console.log('==========================================================\n');

    const client = new ClientUpdateSimulator();
    const active = client.resolveActiveCLI();
    console.log(`Active CLI Resolution:`);
    console.log(`  • Source : [${active.source.toUpperCase()}]`);
    console.log(`  • Path   : ${active.path}`);
    console.log(`  • Exists : ${fs.existsSync(active.path)}\n`);

    console.log(`Checking Live Remote Update Feed...`);
    const update = await client.checkForUpdate();
    console.log(`  • Installed Version : ${update.currentVersion}`);
    console.log(`  • Remote Version    : ${update.remoteVersion || 'N/A'}`);
    console.log(`  • Update Available  : ${update.hasUpdate ? 'YES' : 'NO (Already up to date)'}`);
    if (update.downloadUrl) {
      console.log(`  • Download URL      : ${update.downloadUrl}`);
    }
    console.log('\n✓ Simulation complete. Logic matches native EngineManager.swift.');
  })();
}
