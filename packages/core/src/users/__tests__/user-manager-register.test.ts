import { describe, it, expect } from 'vitest';
import { UserManager } from '../user-manager.js';

describe('UserManager.registerPlatformId', () => {
  it('registers a platform ID at runtime and enables lookup', () => {
    const manager = new UserManager([{ name: 'alice', role: 'admin' }]);
    expect(manager.findByPlatformId('webchat', 'dashboard')).toBeUndefined();

    manager.registerPlatformId('webchat', 'dashboard', 'alice');
    const user = manager.findByPlatformId('webchat', 'dashboard');
    expect(user).toBeDefined();
    expect(user!.name).toBe('alice');
  });

  it('does nothing if user name not found', () => {
    const manager = new UserManager([{ name: 'alice', role: 'admin' }]);
    manager.registerPlatformId('webchat', 'dashboard', 'nonexistent');
    expect(manager.findByPlatformId('webchat', 'dashboard')).toBeUndefined();
  });

  it('overwrites existing platform ID for same platform', () => {
    const manager = new UserManager([
      { name: 'alice', role: 'admin' },
      { name: 'bob', role: 'chat' },
    ]);
    manager.registerPlatformId('webchat', 'dashboard', 'alice');
    manager.registerPlatformId('webchat', 'dashboard', 'bob');
    expect(manager.findByPlatformId('webchat', 'dashboard')!.name).toBe('bob');
  });
});
