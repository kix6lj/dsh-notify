/**
 * dsh-notify — frame-wide session notifications.
 *
 * Client-only; the Host half is intentionally empty. Every input is already
 * maintained by the Harness Client:
 *   - `useSessionStatus` -> Map<SessionId, { running, pendingInteraction, completionUnread }>
 *   - `useSessions`      -> { ids, byId, projectionsBySession } with the `title` projection
 * `completionUnread` is exactly "a session stopped while it was not the main view",
 * so a page (re)load never replays history and finished turns never double-notify.
 * `pendingInteraction` is the highest-precedence request awaiting the user.
 *
 * One derivation, three surfaces:
 *   1. in-page cards in `shell.overlay` — always;
 *   2. OS notifications — only while the page is unattended. The completion of the
 *      session actually on screen comes from `api-session/status`, because the
 *      unread projection deliberately never reports it;
 *   3. tab title prefix + favicon badge — the cue that stays visible while another
 *      site is in front (the OS owns the popup; browsers render no second copy).
 *
 * Tunables live here because a Client module cannot read the Host row's Config.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-notify';
    const ENTRY_ID = 'dsh-notify.toasts';
    const SLOT = 'shell.overlay';

    /** How many cards render before the list collapses behind "N more". */
    const MAX_VISIBLE = 3;
    /** Finished-turn cards disappear on their own; waiting-for-you cards never do. */
    const DONE_AUTO_DISMISS_MS = 6000;
    /** Repaint cadence for the relative timestamps. */
    const CLOCK_TICK_MS = 30000;
    /** Pending-interaction kinds worth interrupting the user for. */
    const VISIBLE_KINDS = new Set(['question', 'plan-review', 'approval']);

    /** localStorage key holding the system-notification preference ('on' | 'off'). */
    const PREF_KEY = 'dsh-notify.system';
    /** Waiting-for-you notifications stay on screen until dismissed. */
    const OS_REQUIRE_INTERACTION = true;

    const DICTS = {
      zh: {
        'action.question': '等待你回答问题',
        'action.planReview': '等待你确认方案',
        'action.approval': '等待你的工具授权',
        done: '本轮处理完成',
        untitled: '未命名会话',
        open: '打开会话',
        dismiss: '关闭通知',
        dismissAll: '全部关闭',
        collapse: '收起',
        more: '还有 {n} 条',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
        osEnable: '开启系统通知',
        osEnableHint: '浏览器会询问一次通知权限',
        osEnabled: '系统通知已开启',
        osEnabledHint: '点击关闭系统通知',
        osBlocked: '系统通知已被浏览器阻止',
        osBlockedHint: '在浏览器地址栏的站点设置中允许通知，然后刷新页面。',
        osTestTitle: '系统通知已开启',
        osTestBody: '当某个会话需要你处理或跑完一轮时，会在这里提醒你。',
      },
      en: {
        'action.question': 'Waiting for your answer',
        'action.planReview': 'Waiting for your plan review',
        'action.approval': 'Waiting for your approval',
        done: 'Turn finished',
        untitled: 'Untitled session',
        open: 'Open session',
        dismiss: 'Dismiss notification',
        dismissAll: 'Dismiss all',
        collapse: 'Collapse',
        more: '{n} more',
        justNow: 'just now',
        minutesAgo: '{n}m ago',
        hoursAgo: '{n}h ago',
        daysAgo: '{n}d ago',
        osEnable: 'Enable system notifications',
        osEnableHint: 'Your browser will ask for permission once',
        osEnabled: 'System notifications on',
        osEnabledHint: 'Click to turn system notifications off',
        osBlocked: 'System notifications blocked',
        osBlockedHint: 'Allow notifications in the browser site settings, then reload the page.',
        osTestTitle: 'System notifications enabled',
        osTestBody: 'You will be notified here when a session needs you or finishes a turn.',
      },
    };

    const CSS = [
      '.dshnotify-layer{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
      'padding:var(--dsh-frame-overlay-top,20px) 16px 0;pointer-events:none;font-family:inherit;',
      '-webkit-font-smoothing:antialiased}',
      '.dshnotify-stack{box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;gap:8px;',
      'width:min(520px,100%);max-height:calc(100vh - 96px);pointer-events:none;scrollbar-width:thin}',
      '.dshnotify-stack--expanded{overflow-y:auto;overscroll-behavior:contain;padding-bottom:4px}',
      '.dshnotify-card{box-sizing:border-box;display:flex;align-items:flex-start;gap:10px;padding:9px 8px 9px 12px;',
      'border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.16));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(12px));pointer-events:auto;',
      'animation:dshnotify-in .18s ease-out}',
      '.dshnotify-dot{flex:none;width:8px;height:8px;margin-top:7px;border-radius:50%;',
      'background:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dshnotify-card--action .dshnotify-dot{background:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.dshnotify-open{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;padding:0;border:0;',
      'background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:6px}',
      '.dshnotify-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}',
      '.dshnotify-title{font-size:13px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#111);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshnotify-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#666);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshnotify-time{flex:none;margin-top:2px;font-size:11px;line-height:16px;',
      'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#888)}',
      '.dshnotify-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;',
      'padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary,#888);cursor:pointer}',
      '.dshnotify-close:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-primary,#111)}',
      '.dshnotify-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      '.dshnotify-footer{display:flex;align-items:center;justify-content:center;gap:6px;pointer-events:none}',
      '.dshnotify-pill{pointer-events:auto;display:inline-flex;align-items:center;padding:4px 11px;border-radius:999px;',
      'background:var(--dsw-alias-bg-overlay,#fff);border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));',
      'box-shadow:var(--dsw-elevation-soft,0 2px 10px rgba(0,0,0,.1));font:inherit;font-size:12px;line-height:16px;',
      'color:var(--dsw-alias-label-secondary,#666);cursor:pointer}',
      '.dshnotify-pill:hover{color:var(--dsw-alias-label-primary,#111);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}',
      '.dshnotify-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      '.dshnotify-pill--on{color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.dshnotify-pill--muted{cursor:default;opacity:.75}',
      '@keyframes dshnotify-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
      '@media (prefers-reduced-motion:reduce){.dshnotify-card{animation:none}}',
    ].join('');

    function fmt(template, count) {
      return String(template).replace('{n}', String(count));
    }

    function formatAgo(at, t) {
      const time = typeof at === 'number' ? at : 0;
      if (time <= 0) return '';
      const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000);
      if (minutes < 1) return t('justNow');
      if (minutes < 60) return fmt(t('minutesAgo'), minutes);
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return fmt(t('hoursAgo'), hours);
      return fmt(t('daysAgo'), Math.floor(hours / 24));
    }

    /** Host list order, minus sessions the user cannot meaningfully act on. */
    function isNotifiable(summary) {
      if (!summary) return false;
      if (summary.blank) return false;
      if (summary.origin === 'subagent') return false;
      return true;
    }

    function sessionTitle(list, summary, t) {
      const projected = list.projectionsBySession && list.projectionsBySession[summary.sessionId];
      const value = projected && projected.values ? projected.values.title : undefined;
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      const hinted = summary.projections && summary.projections.values ? summary.projections.values.title : undefined;
      if (typeof hinted === 'string' && hinted.trim() !== '') return hinted.trim();
      const cwd = typeof summary.cwd === 'string' ? summary.cwd : '';
      const base = cwd.split(/[\\/]/).filter(Boolean).pop();
      if (base) return base;
      return t('untitled');
    }

    function interactionDetail(interaction, t) {
      if (interaction.kind === 'approval') {
        const name = typeof interaction.toolName === 'string' ? interaction.toolName : '';
        return name === '' ? t('action.approval') : t('action.approval') + ' · ' + name;
      }
      const label = interaction.kind === 'plan-review' ? t('action.planReview') : t('action.question');
      const first = interaction.questions && interaction.questions[0];
      const text = first ? first.header || first.question : '';
      return text ? label + ' · ' + text : label;
    }

    /** Electron (Harness Desktop) exposes its own markers in the renderer. */
    function isElectronRuntime() {
      if (typeof navigator !== 'undefined') {
        const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
        if (ua.indexOf('Electron') !== -1) return true;
      }
      const process = typeof window !== 'undefined' ? window.process : undefined;
      return !!(process && process.versions && process.versions.electron);
    }

    /** The Notifications API needs a secure context (https, localhost or 127.0.0.1). */
    function notificationSupport() {
      if (typeof window === 'undefined') return false;
      if (typeof window.Notification !== 'function') return false;
      // Desktop maps the renderer Notification API to native notifications even when
      // the app document is served from a custom protocol that is not "secure".
      if (isElectronRuntime()) return true;
      return window.isSecureContext === true;
    }

    function readPref() {
      try {
        const value = window.localStorage.getItem(PREF_KEY);
        return value === 'on' || value === 'off' ? value : null;
      } catch (error) {
        return null;
      }
    }

    function writePref(value) {
      try {
        if (value === null) window.localStorage.removeItem(PREF_KEY);
        else window.localStorage.setItem(PREF_KEY, value);
      } catch (error) {
        /* storage may be unavailable; the in-memory state still applies */
      }
    }

    /** True when the page is not the thing the user is looking at. */
    function pageUnattended() {
      if (typeof document === 'undefined') return false;
      if (document.visibilityState !== 'visible') return true;
      if (typeof document.hasFocus !== 'function') return false;
      return document.hasFocus() === false;
    }

    function subscribeAttended(listener) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return noopSubscribe();
      document.addEventListener('visibilitychange', listener);
      window.addEventListener('focus', listener);
      window.addEventListener('blur', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
        window.removeEventListener('focus', listener);
        window.removeEventListener('blur', listener);
      };
    }

    function getAttendedSnapshot() {
      return pageUnattended() === false;
    }

    /** Whether the user is currently looking at this page, as a React source. */
    function usePageAttended() {
      return React.useSyncExternalStore(subscribeAttended, getAttendedSnapshot, () => true);
    }

    const TITLE_BADGE = /^\(\d+\)\s/;

    /**
     * One card per session, waiting-for-you before finished, newest first.
     * @returns {{ sessionId: string, kind: 'action'|'done', interactionKey?: string, title: string, detail: string, at: number }[]}
     */
    function deriveItems(list, statuses, dismissedDone, dismissedActions, t) {
      const items = [];
      if (!list || !statuses) return items;
      const ids = list.ids || [];
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        const summary = list.byId ? list.byId[id] : undefined;
        if (!isNotifiable(summary)) continue;
        const status = statuses.get(id);
        if (!status) continue;
        const interaction = status.pendingInteraction;
        if (interaction && VISIBLE_KINDS.has(interaction.kind)) {
          if (dismissedActions.has(interaction.key)) continue;
          items.push({
            sessionId: id,
            kind: 'action',
            interactionKey: interaction.key,
            title: sessionTitle(list, summary, t),
            detail: interactionDetail(interaction, t),
            at: summary.updatedAt,
          });
          continue;
        }
        if (status.completionUnread === true && !dismissedDone.has(id)) {
          items.push({
            sessionId: id,
            kind: 'done',
            title: sessionTitle(list, summary, t),
            detail: t('done'),
            at: summary.updatedAt,
          });
        }
      }
      items.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'action' ? -1 : 1;
        return (right.at || 0) - (left.at || 0);
      });
      return items;
    }

    function noopSubscribe() {
      return function unsubscribe() {};
    }

    function noopSnapshot() {
      return 0;
    }

    /**
     * Mirror the pending count into the tab strip: a `(N)` title prefix and a
     * counted favicon. The OS owns the notification popup; this owns the cue that
     * stays visible while another site is in front.
     * @param count pending notification count; 0 restores the shell's own title.
     */
    function useTabBadge(count) {
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const strip = (value) => value.replace(TITLE_BADGE, '');
        if (count === 0) {
          if (TITLE_BADGE.test(document.title)) document.title = strip(document.title);
          return undefined;
        }
        const paint = () => {
          if (TITLE_BADGE.test(document.title)) return;
          document.title = '(' + count + ') ' + strip(document.title);
        };
        paint();
        // The shell owns the title; re-assert the badge if it rewrites it.
        const handle = window.setInterval(paint, 1000);
        return () => {
          window.clearInterval(handle);
          if (TITLE_BADGE.test(document.title)) document.title = strip(document.title);
        };
      }, [count]);

      React.useEffect(() => {
        if (typeof document === 'undefined' || count === 0) return undefined;
        const existing = document.querySelector('link[rel="icon"]');
        const created = existing === null;
        const element = existing || document.createElement('link');
        const previous = created ? null : element.getAttribute('href');
        if (created) {
          element.setAttribute('rel', 'icon');
          document.head.appendChild(element);
        }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const context = canvas.getContext('2d');
          if (context !== null) {
            context.fillStyle = '#e5484d';
            context.beginPath();
            context.arc(16, 16, 15, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = '#ffffff';
            context.font = 'bold 20px system-ui, sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(count > 9 ? '9+' : String(count), 16, 17);
            element.setAttribute('href', canvas.toDataURL('image/png'));
          }
        } catch (error) {
          /* a canvas-less environment simply keeps the previous icon */
        }
        return () => {
          if (created) element.remove();
          else if (previous === null) element.removeAttribute('href');
          else element.setAttribute('href', previous);
        };
      }, [count]);
    }

    function ToastCard(props) {
      const item = props.item;
      const t = props.t;
      const [paused, setPaused] = React.useState(false);
      const latest = React.useRef(item);
      latest.current = item;

      const itemKey = item.kind + ':' + (item.interactionKey || item.sessionId);
      const autoDismissMs = item.kind === 'done' ? props.autoDismissMs : 0;
      const dismiss = props.onDismiss;
      const attended = props.attended !== false;

      React.useEffect(() => {
        // A card never expires while the page is not being watched: the whole point
        // of the notification is that it is still there when the user comes back.
        if (!autoDismissMs || paused || !attended) return undefined;
        const handle = window.setTimeout(() => dismiss(latest.current), autoDismissMs);
        return () => window.clearTimeout(handle);
      }, [itemKey, autoDismissMs, paused, dismiss, attended]);

      return h(
        'div',
        {
          className: 'dshnotify-card' + (item.kind === 'action' ? ' dshnotify-card--action' : ''),
          onMouseEnter: () => setPaused(true),
          onMouseLeave: () => setPaused(false),
        },
        h('span', { className: 'dshnotify-dot', 'aria-hidden': true }),
        h(
          'button',
          {
            type: 'button',
            className: 'dshnotify-open',
            title: t('open'),
            'aria-label': item.title + ' — ' + item.detail + ' — ' + t('open'),
            onClick: () => props.onOpen(item),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                props.onDismiss(item);
              }
            },
          },
          h('span', { className: 'dshnotify-title' }, item.title),
          h('span', { className: 'dshnotify-sub' }, item.detail),
        ),
        h('span', { className: 'dshnotify-time' }, formatAgo(item.at, t)),
        h(
          'button',
          {
            type: 'button',
            className: 'dshnotify-close',
            title: t('dismiss'),
            'aria-label': t('dismiss'),
            onClick: () => props.onDismiss(item),
          },
          h(
            'svg',
            { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
            h('path', {
              d: 'M4 4l8 8M12 4l-8 8',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
            }),
          ),
        ),
      );
    }

    function NotifyToasts(props) {
      const t = props.t;
      const useSessions = props.useSessions;
      const useSessionStatus = props.useSessionStatus;

      // Locale changes re-render the cards even when no session state moves.
      React.useSyncExternalStore(
        props.subscribeLocale || noopSubscribe,
        props.getLocaleSnapshot || noopSnapshot,
      );

      const list = useSessions((value) => value);
      const statuses = useSessionStatus((value) => value);
      const attended = usePageAttended();

      const osApi = notificationSupport();
      const [osPermission, setOsPermission] = React.useState(() =>
        osApi ? window.Notification.permission : 'unsupported',
      );
      const [osPref, setOsPref] = React.useState(readPref);
      const osEnabled = osApi && osPermission === 'granted' && osPref !== 'off';
      const [promo, setPromo] = React.useState(false);

      const osEnabledRef = React.useRef(osEnabled);
      osEnabledRef.current = osEnabled;
      const osSentRef = React.useRef(new Set());
      const osLiveRef = React.useRef(new Map());
      const listRef = React.useRef(list);
      listRef.current = list;
      const statusesRef = React.useRef(statuses);
      statusesRef.current = statuses;
      const tRef = React.useRef(t);
      tRef.current = t;

      const [dismissedDone, setDismissedDone] = React.useState(() => new Set());
      const [dismissedActions, setDismissedActions] = React.useState(() => new Set());
      const [expanded, setExpanded] = React.useState(false);
      const [, setTick] = React.useState(0);

      // Re-arm dismissed records: a session running again may notify again, and a
      // pending interaction that vanished must not suppress a future request.
      React.useEffect(() => {
        setDismissedDone((previous) => {
          if (previous.size === 0) return previous;
          let changed = false;
          const next = new Set();
          for (const id of previous) {
            const status = statuses.get(id);
            if (status && status.running !== true && status.completionUnread === true) next.add(id);
            else changed = true;
          }
          return changed ? next : previous;
        });
        setDismissedActions((previous) => {
          if (previous.size === 0) return previous;
          const live = new Set();
          for (const status of statuses.values()) {
            if (status && status.pendingInteraction) live.add(status.pendingInteraction.key);
          }
          let changed = false;
          const next = new Set();
          for (const key of previous) {
            if (live.has(key)) next.add(key);
            else changed = true;
          }
          return changed ? next : previous;
        });
      }, [statuses]);

      const items = React.useMemo(
        () => deriveItems(list, statuses, dismissedDone, dismissedActions, t),
        [list, statuses, dismissedDone, dismissedActions, t],
      );

      React.useEffect(() => {
        if (items.length === 0) return undefined;
        const handle = window.setInterval(() => setTick((value) => value + 1), CLOCK_TICK_MS);
        return () => window.clearInterval(handle);
      }, [items.length]);

      React.useEffect(() => {
        if (expanded && items.length <= MAX_VISIBLE) setExpanded(false);
      }, [expanded, items.length]);

      const dismiss = React.useCallback((item) => {
        if (!item) return;
        if (item.kind === 'action' && item.interactionKey) {
          setDismissedActions((previous) => {
            const next = new Set(previous);
            next.add(item.interactionKey);
            return next;
          });
          return;
        }
        setDismissedDone((previous) => {
          const next = new Set(previous);
          next.add(item.sessionId);
          return next;
        });
      }, []);

      const open = React.useCallback(
        (item) => {
          if (!item) return;
          dismiss(item);
          if (typeof props.openSession === 'function') props.openSession(item.sessionId);
        },
        [dismiss, props.openSession],
      );

      const dismissAll = React.useCallback(() => {
        setDismissedActions((previous) => {
          const next = new Set(previous);
          for (const item of items) if (item.kind === 'action' && item.interactionKey) next.add(item.interactionKey);
          return next;
        });
        setDismissedDone((previous) => {
          const next = new Set(previous);
          for (const item of items) if (item.kind === 'done') next.add(item.sessionId);
          return next;
        });
        setExpanded(false);
      }, [items]);

      const emitOs = React.useCallback(
        (payload) => {
          if (typeof window === 'undefined' || !notificationSupport()) return;
          if (window.Notification.permission !== 'granted') return;
          try {
            const notification = new window.Notification(payload.title, {
              body: payload.detail,
              tag: 'dsh-notify:' + payload.sessionId,
              requireInteraction: payload.kind === 'action' && OS_REQUIRE_INTERACTION,
              silent: false,
            });
            notification.onclick = () => {
              try {
                window.focus();
              } catch (error) {
                /* focusing can be refused by the platform */
              }
              if (typeof props.openSession === 'function') props.openSession(payload.sessionId);
              try {
                notification.close();
              } catch (error) {
                /* already closed */
              }
            };
            notification.onclose = () => {
              osLiveRef.current.delete(payload.sessionId);
            };
            osLiveRef.current.set(payload.sessionId, notification);
          } catch (error) {
            /* a platform may refuse construction; the in-page card still shows */
          }
        },
        [props.openSession],
      );

      const closeAllOs = React.useCallback(() => {
        for (const notification of osLiveRef.current.values()) {
          try {
            notification.close();
          } catch (error) {
            /* already closed */
          }
        }
        osLiveRef.current.clear();
      }, []);

      const showOsTest = React.useCallback(() => {
        if (typeof window === 'undefined' || window.Notification.permission !== 'granted') return;
        try {
          new window.Notification(tRef.current('osTestTitle'), {
            body: tRef.current('osTestBody'),
            tag: 'dsh-notify:test',
          });
        } catch (error) {
          /* ignore a refused test notification */
        }
      }, []);

      const enableOs = React.useCallback(async () => {
        if (!notificationSupport()) {
          setOsPermission('unsupported');
          return;
        }
        let permission = window.Notification.permission;
        if (permission === 'default') {
          try {
            permission = await window.Notification.requestPermission();
          } catch (error) {
            permission = window.Notification.permission;
          }
        }
        setOsPermission(permission);
        if (permission !== 'granted') return;
        setOsPref('on');
        writePref('on');
        showOsTest();
      }, [showOsTest]);

      const disableOs = React.useCallback(() => {
        setOsPref('off');
        writePref('off');
        closeAllOs();
      }, [closeAllOs]);

      // Keep the permission badge honest when the user changes it in site settings.
      React.useEffect(() => {
        if (!osApi || typeof document === 'undefined') return undefined;
        const sync = () => setOsPermission(window.Notification.permission);
        document.addEventListener('visibilitychange', sync);
        return () => document.removeEventListener('visibilitychange', sync);
      }, [osApi]);

      // Offer the permission until the user decides; the pill retires itself.
      React.useEffect(() => {
        if (!osApi) return;
        if (window.Notification.permission !== 'default') return;
        setPromo(true);
      }, [osApi]);

      // The offer retires itself so it never becomes permanent furniture.
      React.useEffect(() => {
        if (!promo) return undefined;
        const handle = window.setTimeout(() => setPromo(false), 30000);
        return () => window.clearTimeout(handle);
      }, [promo]);

      // Keep the tab strip honest about pending notifications.
      useTabBadge(items.length);

      // Close system notifications when the plugin itself goes away.
      React.useEffect(
        () => () => {
          for (const notification of osLiveRef.current.values()) {
            try {
              notification.close();
            } catch (error) {
              /* already closed */
            }
          }
          osLiveRef.current.clear();
        },
        [],
      );

      // System notifications for cards the page is already presenting.
      React.useEffect(() => {
        if (!osEnabled) return;
        const sent = osSentRef.current;
        const liveInteractions = new Set();
        for (const status of statuses.values()) {
          if (status && status.pendingInteraction) liveInteractions.add(status.pendingInteraction.key);
        }
        for (const key of Array.from(sent)) {
          if (key.indexOf('action:') === 0 && !liveInteractions.has(key.slice(7))) sent.delete(key);
        }
        for (const id of statuses.keys()) {
          const status = statuses.get(id);
          if (status && status.running === true) sent.delete('done:' + id);
        }
        const unattended = pageUnattended();
        for (const item of items) {
          const key = item.kind === 'action' ? 'action:' + item.interactionKey : 'done:' + item.sessionId;
          if (sent.has(key)) continue;
          // Marked even when the user is watching: the in-page card already showed it,
          // and a stale system notification minutes later would only be noise.
          sent.add(key);
          if (!unattended) continue;
          emitOs(item);
        }
      }, [items, statuses, osEnabled, emitOs]);

      // The one completion the unread projection never reports: the session the
      // user is currently viewing, when the window itself is not being watched.
      // This is an enhancement only: a failure here must never cost the cards.
      React.useEffect(() => {
        const subscribe = props.subscribeSessionStatus;
        if (typeof subscribe !== 'function') return undefined;
        const previous = new Map();
        for (const [id, status] of statusesRef.current.entries()) previous.set(id, status ? status.running : undefined);
        let dispose;
        try {
          dispose = subscribe((sessionId, running) => {
            const before = previous.get(sessionId);
            previous.set(sessionId, running);
            if (before !== true || running !== false) return;
            if (!osEnabledRef.current) return;
            if (!pageUnattended()) return;
            let isMain = false;
            try {
              isMain = typeof props.isMainView === 'function' && props.isMainView(sessionId) === true;
            } catch (error) {
              isMain = false;
            }
            if (!isMain) return;
            const listNow = listRef.current;
            const summary = listNow && listNow.byId ? listNow.byId[sessionId] : undefined;
            if (!isNotifiable(summary)) return;
            const key = 'done:' + sessionId;
            if (osSentRef.current.has(key)) return;
            osSentRef.current.add(key);
            emitOs({
              sessionId,
              kind: 'done',
              title: sessionTitle(listNow, summary, tRef.current),
              detail: tRef.current('done'),
            });
          });
        } catch (error) {
          return undefined;
        }
        return typeof dispose === 'function' ? dispose : undefined;
      }, [emitOs, props.subscribeSessionStatus, props.isMainView]);

      const visible = expanded ? items : items.slice(0, MAX_VISIBLE);
      const hiddenCount = items.length - visible.length;

      const osPill = !osApi
        ? null
        : osEnabled
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshnotify-pill dshnotify-pill--on',
                title: t('osEnabledHint'),
                onClick: disableOs,
              },
              t('osEnabled'),
            )
          : osPermission === 'denied'
            ? h('span', { className: 'dshnotify-pill dshnotify-pill--muted', title: t('osBlockedHint') }, t('osBlocked'))
            : h(
                'button',
                { type: 'button', className: 'dshnotify-pill', title: t('osEnableHint'), onClick: enableOs },
                t('osEnable'),
              );

      const footer =
        hiddenCount > 0 || expanded || items.length >= 2 || osPill !== null
          ? h(
              'div',
              { className: 'dshnotify-footer', key: 'footer' },
              hiddenCount > 0
                ? h(
                    'button',
                    { type: 'button', className: 'dshnotify-pill', onClick: () => setExpanded(true) },
                    fmt(t('more'), hiddenCount),
                  )
                : null,
              expanded
                ? h(
                    'button',
                    { type: 'button', className: 'dshnotify-pill', onClick: () => setExpanded(false) },
                    t('collapse'),
                  )
                : null,
              items.length >= 2
                ? h('button', { type: 'button', className: 'dshnotify-pill', onClick: dismissAll }, t('dismissAll'))
                : null,
              osPill,
            )
          : null;

      const onboarding =
        items.length === 0 && promo && osPermission === 'default' && osPill !== null
          ? h(
              'div',
              { className: 'dshnotify-stack' },
              h('div', { className: 'dshnotify-footer', key: 'onboarding' }, osPill),
            )
          : null;

      const stack = visible.length
        ? h(
            'div',
            {
              className: 'dshnotify-stack' + (expanded ? ' dshnotify-stack--expanded' : ''),
              style: expanded ? { pointerEvents: 'auto' } : undefined,
            },
            visible.map((item) =>
              h(ToastCard, {
                key: item.kind + ':' + (item.interactionKey || item.sessionId),
                item,
                t,
                attended,
                autoDismissMs: DONE_AUTO_DISMISS_MS,
                onOpen: open,
                onDismiss: dismiss,
              }),
            ),
            footer,
          )
        : onboarding;

      return h(
        'div',
        { className: 'dshnotify-layer', style: { pointerEvents: 'none' } },
        h('style', { key: 'css' }, CSS),
        stack,
      );
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'sessions', 'remote'],
      apply(ctx) {
        const injected = {
          t: ctx.locale.bind(NS),
          subscribeLocale: (listener) => ctx.locale.subscribe(listener),
          getLocaleSnapshot: () => ctx.locale.getSnapshot(),
          openSession: (sessionId) => {
            ctx.uiWorkspace.openSession(sessionId);
          },
          subscribeSessionStatus: (handler) => ctx.remote.$on('api-session/status', handler),
          isMainView: (sessionId) => {
            const info = ctx.sessions.retainInfo(sessionId).getSnapshot();
            const count = info && info.retainedBy ? info.retainedBy.mainView : undefined;
            return typeof count === 'number' && count > 0;
          },
        };

        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh));
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en));

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: 100,
              locale: NS,
              inject: () => injected,
            },
            NotifyToasts,
          ),
        );
      },
    };
  },
});
