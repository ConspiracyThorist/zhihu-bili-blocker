/**
 * 浮窗（core/widget）的 DOM 测试。
 *
 * 起因：给「匿名贡献 UP」加开关时只改了扩展弹窗，油猴浮窗漏了，
 * 而 E2E 只跑扩展，抓不到这类「一端有、一端没有」的问题。
 * 这里直接挂真实浮窗，断言面板内容与回调行为。
 */
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const failures: string[] = [];
let passed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) passed += 1;
  else failures.push(label);
}

/** 每个用例一个干净 DOM；挂载前把全局补齐，widget 直接用 document/window */
function withDom(): { window: Window; cleanup: () => void } {
  const window = new Window({ url: 'https://www.bilibili.com/' });
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    window: g.window,
    localStorage: g.localStorage,
    MutationObserver: g.MutationObserver,
  };
  g.document = window.document;
  g.window = window;
  g.localStorage = window.localStorage;
  g.MutationObserver = window.MutationObserver;
  return {
    window,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) g[k] = v;
      window.close();
    },
  };
}

const baseOptions = {
  getSession: () => 0,
  getTotal: () => 0,
  getPool: () => 0,
  getRecords: () => [],
  onAllow: () => {},
};

export async function runWidget(): Promise<{ passed: number; failures: string[] }> {
  const { mountWidget } = await import('../src/core/widget');

  // ---- 1. 传了贡献开关：面板里必须有它 ----
  {
    const dom = withDom();
    try {
      const calls: boolean[] = [];
      const widget = mountWidget({
        ...baseOptions,
        settings: {
          getEnabled: () => true,
          onToggle: () => {},
          getThreshold: () => 0.86,
          onThreshold: () => {},
          getPoolInfo: () => '题库 3 条',
          getContribute: () => true,
          onContribute: (v) => calls.push(v),
          onRefresh: () => {},
          onSyncSeed: () => {},
        },
      });
      widget.open();

      const host = dom.window.document.getElementById('zbb-widget');
      const shadow = host?.shadowRoot as unknown as ParentNode | null;
      const labels = [...(shadow?.querySelectorAll('.adv-row span') ?? [])].map((n) => n.textContent ?? '');
      ok(labels.includes('匿名贡献 UP'), '浮窗高级设置：渲染了「匿名贡献 UP」', );

      const toggle = shadow?.querySelector('.adv-toggle') as HTMLInputElement | null;
      ok(!!toggle, '浮窗高级设置：存在贡献开关元素');
      ok(toggle?.checked === true, '浮窗高级设置：开关初始状态跟随设置');

      if (toggle) {
        toggle.checked = false;
        toggle.dispatchEvent(new dom.window.Event('change') as unknown as Event);
        ok(calls.length === 1 && calls[0] === false, '浮窗高级设置：关闭开关时回调收到 false');
      }
      widget.destroy();
    } finally {
      dom.cleanup();
    }
  }

  // ---- 2. 没传贡献开关：不应该渲染 ----
  {
    const dom = withDom();
    try {
      const widget = mountWidget({
        ...baseOptions,
        settings: {
          getEnabled: () => true,
          onToggle: () => {},
          getThreshold: () => 0.86,
          onThreshold: () => {},
          getPoolInfo: () => '题库 3 条',
        },
      });
      widget.open();
      const host = dom.window.document.getElementById('zbb-widget');
      const shadow = host?.shadowRoot as unknown as ParentNode | null;
      ok(!shadow?.querySelector('.adv-toggle'), '浮窗高级设置：未提供回调时不渲染贡献开关');
      widget.destroy();
    } finally {
      dom.cleanup();
    }
  }

  // ---- 3. 油猴入口必须把这些能力接上（回归防线）----
  {
    const main = await readFile(join(process.cwd(), 'src', 'userscript', 'main.ts'), 'utf8');
    ok(main.includes('getContribute:'), '油猴入口：接入了贡献开关');
    ok(main.includes('onContribute:'), '油猴入口：接入了贡献开关回调');
    ok(main.includes('getPoolInfo'), '油猴入口：接入了题库信息');
    ok(main.includes('onSyncSeed'), '油猴入口：接入了题库同步');
  }

  return { passed, failures };
}
