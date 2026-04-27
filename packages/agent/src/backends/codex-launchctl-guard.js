import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SERVICE_LABEL = 'com.ccbuddy.agent';
const GUARD_DIR_PREFIX = 'ccbuddy-codex-launchctl-guard-';
export function shouldInstallLaunchctlGuard(gateRules) {
    return gateRules?.some((rule) => (rule.name === 'launchctl'
        && (rule.tool === 'Bash' || rule.tool === '*'))) ?? false;
}
export function createLaunchctlGuardBin() {
    const guardDir = mkdtempSync(join(tmpdir(), GUARD_DIR_PREFIX));
    const guardPath = join(guardDir, 'launchctl');
    writeFileSync(guardPath, launchctlGuardScript(), 'utf8');
    chmodSync(guardPath, 0o755);
    return guardDir;
}
export function prependPathEntry(env, pathEntry) {
    const currentPath = env.PATH ?? process.env.PATH ?? '';
    env.PATH = currentPath.length > 0 ? `${pathEntry}:${currentPath}` : pathEntry;
}
export function removeLaunchctlGuardBin(guardDir) {
    if (!guardDir)
        return;
    try {
        rmSync(guardDir, { recursive: true, force: true });
    }
    catch { /* ignore cleanup errors */ }
}
function launchctlGuardScript() {
    return `#!/bin/sh
command_name="\${1:-}"

case "$command_name" in
  bootout|bootstrap|kickstart|stop|remove|unload|load|enable|disable|kill)
    case " $* " in
      *"${SERVICE_LABEL}"*)
        echo "CCBuddy launchctl guard: refusing to run launchctl $command_name for ${SERVICE_LABEL} from inside CCBuddy. Use the SIGUSR1 self-restart path instead." >&2
        exit 126
        ;;
    esac
    ;;
esac

exec /bin/launchctl "$@"
`;
}
