window.__ModuleLoader__.load({
	id: "@local/dsh-quota-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback } = react;
		let reactDom = require("react-dom");
		const createPortal = reactDom.createPortal;
		/* ===== UI kit v4：整段粘贴，勿改本地副本（改 skill 里的源文件再重贴） ===== */
function createUi(react, createPortal) {
  const h = react.createElement
  const { useState, useEffect, useCallback, useRef } = react

  /* ---------- token 与字号 ---------- */
  const T = {
    text1: 'var(--dsw-alias-label-primary)',
    text2: 'var(--dsw-alias-label-secondary)',
    text3: 'var(--dsw-alias-label-tertiary, #8b929c)',
    line: 'var(--dsw-alias-border-l3)',
    cardFill: 'var(--dsw-alias-settings-card-fill, #2c2c2e)',
    cardStroke: 'var(--dsw-alias-settings-card-stroke, #ffffff26)',
    inputFill: 'var(--dsw-alias-bg-layer-1, #1b1b1c)',
    accent: 'var(--dsw-alias-button-primary-fill, #f9fafb)',
    accentText: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
    radiusMd: 'var(--dsw-radius-md, 12px)',
    radiusXl: 'var(--dsw-radius-xl, 20px)',
  }
  const CARD_BG = 'color-mix(in srgb, currentColor 6%, transparent)'
  const TYPE = {
    /* 官方设置页分区头：标题 18/600，说明 13 弱色（宿主 PluginsSettingsSection.css） */
    h1: { fontSize: 18, fontWeight: 600, lineHeight: '26px', color: T.text1 },
    h2: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1 },
    body: { fontSize: 13, lineHeight: '20px', color: T.text1 },
    secondary: { fontSize: 13, lineHeight: '20px', color: T.text2 },
    intro: { fontSize: 13, lineHeight: '20px', color: T.text3 },
    small: { fontSize: 12, lineHeight: '18px', color: T.text2 },
    micro: { fontSize: 11, lineHeight: '14px', color: T.text2 },
    num: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1, fontVariantNumeric: 'tabular-nums' },
    ellipsis: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }

  /* ---------- 纯函数 ---------- */
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max))

  /** 浮层定位：优先右侧，放不下翻左；上下夹在视口内。pure，便于脱离 DOM 测试。 */
  function placeNear(rect, options = {}) {
    const width = options.width ?? 248
    const height = options.height ?? 120
    const gap = options.gap ?? 8
    const vw = options.viewport?.width ?? (typeof window === 'undefined' ? 1280 : window.innerWidth)
    const vh = options.viewport?.height ?? (typeof window === 'undefined' ? 800 : window.innerHeight)
    let side = 'right'
    let left = rect.right + gap
    if (left + width > vw - gap) {
      side = 'left'
      left = rect.left - gap - width
    }
    return {
      side,
      left: clamp(left, gap, Math.max(gap, vw - width - gap)),
      top: clamp(rect.top, gap, Math.max(gap, vh - height - gap)),
    }
  }

  const formatBytes = (bytes) => {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  /* ---------- 本地状态：模块级 store + hook ---------- */
  /** 按设备持久化；只存差异值也安全（读取时与默认值合并）。 */
  function createStore(key, defaults = {}) {
    const read = () => {
      try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }
      } catch {
        return { ...defaults }
      }
    }
    const store = {
      key,
      value: read(),
      listeners: new Set(),
      set(next) {
        store.value = typeof next === 'function' ? next(store.value) : next
        try { localStorage.setItem(key, JSON.stringify(store.value)) } catch {}
        for (const listener of store.listeners) listener(store.value)
      },
      patch(part) { store.set({ ...store.value, ...part }) },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
    }
    return store
  }

  function useStore(store) {
    const [value, setValue] = useState(store.value)
    useEffect(() => store.subscribe(setValue), [store])
    return value
  }

  /** 轮询 + 失败保留上一帧（不要闪成空）。返回 [data, error, refresh]。 */
  function usePoll(task, intervalMs, deps = []) {
    const [state, setState] = useState({ data: null, error: false })
    const run = useCallback(async () => {
      try {
        const data = await task()
        setState({ data, error: false })
      } catch {
        setState((prev) => ({ data: prev.data, error: true }))
      }
    }, deps)
    useEffect(() => {
      run()
      const timer = setInterval(run, intervalMs)
      return () => clearInterval(timer)
    }, [run, intervalMs])
    return [state.data, state.error, run]
  }

  /* ---------- 侧栏卡片 ---------- */
  const StatusDot = ({ color, size = 6, offset = 1.5 }) => h('span', {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: color || T.text3,
      flex: '0 0 auto',
      alignSelf: 'center',
      transform: `translateY(${offset}px)`,
    },
  })

  /** 侧栏卡片：一行，圆点 + 名称 + 右侧数字。左右两组用同一 baseline。 */
  const Card = ({ children, style, ...rest }) => h('div', {
    ...rest,
    style: {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      padding: '2px 12px 5px',
      borderRadius: T.radiusMd,
      background: CARD_BG,
      minWidth: 0,
      overflow: 'hidden',
      ...style,
    },
  }, children)

  /** 侧栏卡片容器：竖排 + 3px 间距 + 左右 2px 内缩（与 newSession 对齐）。 */
  const CardStack = ({ children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 3, padding: '0 2px 2px', minWidth: 0 },
  }, children)

  const CardName = ({ children }) => h('span', { style: { ...TYPE.h2, fontSize: 12, flex: '1 1 auto', ...TYPE.ellipsis } }, children)
  const CardValue = ({ children }) => h('span', {
    style: { display: 'flex', alignItems: 'baseline', gap: 4, flex: '0 0 auto', ...TYPE.num },
  }, children)

  /* ---------- 设置页 ---------- */
  /* 官方分区结构：flex column gap 12，h2 标题 + p 说明（说明 13 弱色），下面才是内容 */
  const Section = ({ title, description, children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, minWidth: 0 },
  },
  h('h2', { style: { margin: 0, ...TYPE.h1 } }, title),
  description ? h('p', { style: { margin: 0, ...TYPE.intro } }, description) : null,
  children)

  /** 设置卡片：官方那种 20px 圆角、深色填充、细描边。 */
  const SettingsCard = ({ children, style }) => h('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '14px 16px',
      borderRadius: T.radiusXl,
      border: `.5px solid ${T.cardStroke}`,
      background: T.cardFill,
      minWidth: 0,
      ...style,
    },
  }, children)

  /** 左标签 + 右控件的一行。 */
  const SettingRow = ({ label, hint, children }) => h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
    h('span', { style: { fontSize: 13, lineHeight: '20px', color: T.text1 } }, label),
    hint ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: T.text2 } }, hint) : null),
  children)

  /** 药丸开关：36×20，白色底 + 深色旋钮，与官方设置页一致。 */
  const Switch = ({ checked, onChange, title, disabled = false }) => h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    disabled,
    onClick: onChange,
    title,
    style: {
      boxSizing: 'border-box',
      position: 'relative',
      flex: '0 0 auto',
      width: 36,
      height: 20,
      padding: 2,
      border: 0,
      borderRadius: 999,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      transition: 'background-color .12s ease',
      backgroundColor: checked ? T.accent : 'var(--dsw-alias-border-l3, #4a4a4d)',
    },
  }, h('span', {
    style: {
      display: 'block',
      width: 16,
      height: 16,
      borderRadius: '50%',
      backgroundColor: checked ? T.accentText : 'var(--dsw-alias-label-primary, #f9fafb)',
      transition: 'background-color .12s ease',
    },
  }))

  const Button = ({ children, onClick, variant = 'primary', disabled = false, type = 'button' }) => h('button', {
    type,
    onClick,
    disabled,
    style: {
      boxSizing: 'border-box',
      height: 36,
      padding: '0 16px',
      borderRadius: T.radiusMd,
      whiteSpace: 'nowrap',
      flex: 'none',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      fontSize: 13,
      lineHeight: '20px',
      fontWeight: 500,
      ...(variant === 'primary'
        ? { border: 'none', background: T.accent, color: T.accentText }
        : { border: `.5px solid ${T.cardStroke}`, background: 'transparent', color: T.text1 }),
    },
  }, children)

  /** 文本输入：44px 高、12px 圆角，与官方设置字段一致。 */
  /** 输入框：与 Select / Button 同高（36px），支持单位后缀、禁用、错误态、回车提交。 */
  const Input = ({
    value,
    onChange,
    placeholder = '',
    type = 'text',
    width = 220,
    unit,
    disabled = false,
    invalid = false,
    min,
    max,
    step,
    autoFocus = false,
    onEnter,
  }) => {
    const [focused, setFocused] = useState(false)
    const border = invalid ? 'var(--dsw-alias-state-error-primary, #ff6262)' : focused ? T.text3 : T.cardStroke
    return h('div', {
      style: {
        width,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        boxSizing: 'border-box',
        padding: '0 10px',
        borderRadius: T.radiusMd,
        border: `.5px solid ${border}`,
        background: T.inputFill,
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
      },
    },
      h('input', {
        type,
        value: value ?? '',
        placeholder,
        disabled,
        min,
        max,
        step,
        autoFocus,
        onChange: (event) => onChange?.(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown: (event) => { if (event.key === 'Enter') onEnter?.(event.target.value) },
        style: {
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 'none',
          background: 'transparent',
          color: T.text1,
          fontSize: 13,
          lineHeight: '20px',
          padding: 0,
        },
      }),
      unit ? h('span', { style: { ...TYPE.micro, flex: 'none' } }, unit) : null,
    )
  }

  /** 带标签/说明的输入框（Input 的组合封装，保留旧 API）。 */
  const TextField = ({ label, hint, width = '100%', ...props }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  },
  label ? h('span', { style: { fontSize: 12, lineHeight: '16px', color: T.text2 } }, label) : null,
  h(Input, { width, ...props }),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /* ---------- 浮层 ---------- */
  /** 悬停详情卡：portal 到 body，先按估算高度定位，挂载后按实测高度夹取。 */
  function HoverCard({ rect, width = 248, estimated = 120, children }) {
    const ref = useRef(null)
    const [placement, setPlacement] = useState(() => placeNear(rect, { width, height: estimated }))
    useEffect(() => {
      const node = ref.current
      if (!node) return
      const measured = node.getBoundingClientRect().height || estimated
      setPlacement(placeNear(rect, { width, height: measured }))
    }, [rect, width, estimated])
    const node = h('div', {
      ref,
      style: {
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width,
        zIndex: 2147400000,
        background: T.cardFill,
        border: `.5px solid ${T.cardStroke}`,
        borderRadius: T.radiusXl,
        padding: '12px 14px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        color: T.text1,
      },
    }, children)
    return createPortal && typeof document !== 'undefined' ? createPortal(node, document.body) : node
  }

  /** 详情卡里的一行：左标题、右值。 */
  const InfoRow = ({ label, value }) => h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text2 } }, label),
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text1, fontVariantNumeric: 'tabular-nums' } }, value))

  /* ---------- 通用控件 ---------- */

  /** 下拉：触发器与设置输入框同高；浮层在触发器内绝对定位（不 portal），宽度与触发器一致。 */
  function Select({ value, options = [], onChange, width = 220, placeholder = '', disabled = false }) {
    const [open, setOpen] = useState(false)
    const [hover, setHover] = useState(-1)
    const ref = useRef(null)
    const current = options.find((option) => option.value === value)

    useEffect(() => {
      if (!open) return undefined
      const onDown = (event) => { if (ref.current && ref.current.contains(event.target)) return; setOpen(false) }
      const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    const trigger = {
      boxSizing: 'border-box',
      width: '100%',
      height: 36,
      padding: '0 8px 0 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      borderRadius: T.radiusMd,
      border: `.5px solid ${T.cardStroke}`,
      background: T.inputFill,
      color: T.text1,
      fontSize: 13,
      lineHeight: '20px',
      cursor: disabled ? 'default' : 'pointer',
      textAlign: 'left',
      opacity: disabled ? 0.55 : 1,
    }

    return h('div', { ref, style: { position: 'relative', width, minWidth: 0 } },
      h('button', {
        type: 'button',
        disabled,
        onClick: () => { if (disabled) return; setHover(-1); setOpen((previous) => !previous) },
        style: trigger,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
      },
        h('span', { style: { ...TYPE.ellipsis, flex: 1, textAlign: 'left', color: current ? T.text1 : T.text2 } }, current ? current.label : placeholder),
        h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text2,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: 'none', transition: 'transform .12s ease', transform: open ? 'rotate(180deg)' : 'none' },
        }, h('path', { d: 'M6 9l6 6 6-6' })),
      ),
      open && !disabled ? h('div', {
        role: 'listbox',
        style: {
          boxSizing: 'border-box',
          position: 'absolute',
          left: 0,
          top: 'calc(100% + 6px)',
          width,
          maxHeight: 320,
          overflowY: 'auto',
          padding: 4,
          zIndex: 40,
          background: T.cardFill,
          border: `.5px solid ${T.cardStroke}`,
          borderRadius: T.radiusMd,
          boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        },
      }, options.map((option, index) => h('div', {
        key: option.value,
        role: 'option',
        'aria-selected': option.value === value,
        onMouseEnter: () => setHover(index),
        onMouseLeave: () => setHover(-1),
        onClick: () => { onChange?.(option.value); setOpen(false) },
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          fontSize: 13,
          lineHeight: '20px',
          color: T.text1,
          cursor: 'pointer',
          background: hover === index
            ? 'color-mix(in srgb, currentColor 8%, transparent)'
            : option.value === value ? 'color-mix(in srgb, currentColor 4%, transparent)' : 'transparent',
        },
      },
        h('span', { style: { ...TYPE.ellipsis } }, option.label),
        option.value === value ? h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text1,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, h('path', { d: 'M5 13l4 4L19 7' })) : null,
      ))) : null,
    )
  }

  /** 分段切换（2~4 项）：选中项白底黑字，未选中透明，整组与输入框同高。 */
  function Segmented({ value, options = [], onChange }) {
    return h('div', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        height: 36,
        padding: 2,
        boxSizing: 'border-box',
        borderRadius: T.radiusMd,
        border: `.5px solid ${T.cardStroke}`,
        background: T.inputFill,
      },
    }, options.map((option) => {
      const active = option.value === value
      return h('button', {
        key: option.value,
        type: 'button',
        onClick: () => onChange?.(option.value),
        style: {
          height: 30,
          padding: '0 12px',
          border: 'none',
          borderRadius: 9,
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: '20px',
          background: active ? T.accent : 'transparent',
          color: active ? T.accentText : T.text2,
          transition: 'background-color .12s ease, color .12s ease',
        },
      }, option.label)
    }))
  }

  /** 图标按钮：28×28，hover 有底色；用于行内删除、刷新等。 */
  const IconButton = ({ label, onClick, disabled = false, children }) => h('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    onClick,
    disabled,
    style: {
      width: 28,
      height: 28,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 0,
      borderRadius: 8,
      background: 'transparent',
      color: disabled ? T.text3 : T.text2,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    },
  }, children)

  /** 指标块：上标签、下数值，用于面板顶部摘要。 */
  const StatTile = ({ label, value, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 },
  },
  h('span', { style: TYPE.micro }, label),
  h('span', { style: { ...TYPE.num } }, value),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /** 空态：居中提示，不占空容器。 */
  const EmptyState = ({ title, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '24px 12px', textAlign: 'center' },
  },
  h('span', { style: TYPE.body }, title),
  hint ? h('span', { style: TYPE.small }, hint) : null)

  return {
    h, T, TYPE, CARD_BG,
    clamp, placeNear, formatBytes,
    createStore, useStore, usePoll,
    Card, CardStack, CardName, CardValue, StatusDot,
    Section, SettingsCard, SettingRow, Switch, Button, Input, TextField,
    Select, Segmented, IconButton, StatTile, EmptyState,
    HoverCard, InfoRow,
  }
}
		const ui = createUi(react, createPortal);
		const { Section, SettingsCard, SettingRow, Switch, Button, Input } = ui;
		/* ===== kit end ===== */

		// DSH-native design vocabulary, taken from the app's own sidebar rules
		// (dsh-client-ui-sidebar: .panelRow / .newSession):
		//   panels -> border-radius: var(--dsw-radius-md); padding: 6px 12px
		//   text   -> var(--dsw-alias-label-primary/-secondary), 10-15px
		// Reference the tokens instead of hardcoding, so theming stays in sync.
		const RADIUS_MD = "var(--dsw-radius-md)";
		const TEXT_1 = "var(--dsw-alias-label-primary)";
		const TEXT_2 = "var(--dsw-alias-label-secondary)";
		const line = "var(--dsw-alias-border-l3)";

		const cardBg = "color-mix(in srgb, currentColor 6%, transparent)";
		const label = { color: TEXT_2, fontSize: 11, lineHeight: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
		const num = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
		// Card title: same treatment in every card so the panel reads as one system.
		const blockHead = { fontSize: 12, fontWeight: 500, lineHeight: "16px", color: TEXT_1, whiteSpace: "nowrap", flex: "none" };

		/**
		 * Group container. Horizontal metrics copied from the app's new-session
		 * button so the panel lines up with it: the sidebar already insets its
		 * content by 12px, the button adds `margin: 0 2px` and `padding: 8px 12px`,
		 * so the card box sits at 14px and its text at 26px from the edge.
		 */
		const groupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 1,
			padding: "4px 12px",
			borderRadius: RADIUS_MD,
			background: cardBg,
			minWidth: 0,
		};
		const PANEL_INSET = 2; // matches .newSession margin: 0 2px
		const CARD_GAP = 3;   // spacing between cards

		const STAT = {
			ok: "var(--dsw-alias-state-success-primary, #43c982)",
			warn: "var(--dsw-alias-state-warn-primary, #efb83f)",
			bad: "var(--dsw-alias-state-error-primary, #ff6262)",
			off: "var(--dsw-alias-label-tertiary, #6b7078)",
		};
		// Wide enough for a provider name, clamped to the viewport on open.
				// Only explicitly-hidden entries are stored: a provider added later is
		// therefore visible without touching this record.
		const STORE_KEY = "dsh-quota-panel.show";
		// Vertical padding of the codex card. The rows are baseline-aligned (so left
		// and right share a line), which makes the ink sit slightly high inside the
		// box; 3/5 measured 13/12 device px at 2x. One knob for future tweaks.
		const CODEX_PAD = "1px 12px 6px";
		// Same idea for the single-line provider card: baseline alignment leaves the
		// ink ~1px low, so the bottom padding is slightly larger.
		const CARD_PAD = "2px 12px 5px";

		function readShow() {
			try {
				const raw = localStorage.getItem(STORE_KEY);
				return raw ? JSON.parse(raw) : {};
			} catch {
				return {};
			}
		}

		/**
		 * Which cards are visible, shared by the sidebar and the settings page so the
		 * toggle there updates the panel at once. Only explicit `false` is stored.
		 */
		const showStore = {
			value: readShow(),
			listeners: new Set(),
			set(next) {
				showStore.value = next;
				try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
				for (const listener of showStore.listeners) listener(next);
			},
			subscribe(listener) {
				showStore.listeners.add(listener);
				return () => { showStore.listeners.delete(listener) };
			},
		};
		function useShow() {
			const [value, setValue] = useState(showStore.value);
			useEffect(() => showStore.subscribe(setValue), []);
			return value;
		}

		// 面板总开关：关掉后侧栏一张卡都不显示（连带收起态的圆点），设置页仍可打开。
		// 只存 "false"，默认（无记录）为开，这样新设备无需迁移。
		const ENABLED_KEY = "dsh-quota-panel.enabled";
		const readEnabled = () => {
			try {
				return localStorage.getItem(ENABLED_KEY) !== "false";
			} catch {
				return true;
			}
		};
		const enabledStore = {
			value: readEnabled(),
			listeners: new Set(),
			set(next) {
				enabledStore.value = next;
				try { localStorage.setItem(ENABLED_KEY, next ? "true" : "false"); } catch {}
				for (const listener of enabledStore.listeners) listener(next);
			},
			subscribe(listener) {
				enabledStore.listeners.add(listener);
				return () => { enabledStore.listeners.delete(listener) };
			},
		};
		function useEnabled() {
			const [value, setValue] = useState(enabledStore.value);
			useEffect(() => enabledStore.subscribe(setValue), []);
			return value;
		}

		// Codex card display switches, per device. Shared by the sidebar card and the
		// settings page (same document), so flipping one updates the panel at once.
		const CODEX_PREFS_KEY = "dsh-quota-panel.codex";
		const CODEX_PREFS_DEFAULT = { fiveHour: true, weekly: true, reset: true, resets: true };
		const readCodexPrefs = () => {
			try {
				return { ...CODEX_PREFS_DEFAULT, ...JSON.parse(localStorage.getItem(CODEX_PREFS_KEY) || "{}") };
			} catch {
				return { ...CODEX_PREFS_DEFAULT };
			}
		};
		const codexPrefs = {
			value: readCodexPrefs(),
			listeners: new Set(),
			set(next) {
				codexPrefs.value = next;
				try { localStorage.setItem(CODEX_PREFS_KEY, JSON.stringify(next)); } catch {}
				for (const listener of codexPrefs.listeners) listener(next);
			},
			subscribe(listener) {
				codexPrefs.listeners.add(listener);
				return () => { codexPrefs.listeners.delete(listener) };
			},
		};
		function useCodexPrefs() {
			const [value, setValue] = useState(codexPrefs.value);
			useEffect(() => codexPrefs.subscribe(setValue), []);
			return value;
		}

		/**
		 * One quota cell: the amount, its category, then the reset time — all on
		 * one line. They live in a single nowrap span so the whole cell ellipsizes
		 * at the end; splitting them into flex items let a narrow column clip the
		 * leading number instead of truncating the tail.
		 */
		function MetricCell({ value, unit, category, reset, categoryTitle, valueTitle, compact }) {
			const amount = value === null || value === undefined ? "--" : String(value);
			const small = { fontSize: 10, lineHeight: "13px", color: TEXT_2 };
			return react.createElement(
				"div",
				{ style: { display: "flex", alignItems: "baseline", minWidth: 0, flex: "1 1 auto" } },
				react.createElement(
					"span",
					{
						title: valueTitle || undefined,
						style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
					},
					react.createElement("span", { style: { ...num, fontSize: compact ? 13 : 15, fontWeight: 600, lineHeight: compact ? "15px" : "20px", color: TEXT_1 } }, amount),
					unit ? react.createElement("span", { style: small }, unit) : null,
					category ? react.createElement("span", { title: categoryTitle || undefined, style: { ...small, marginLeft: 4 } }, category) : null,
					reset ? react.createElement("span", { style: { ...small, marginLeft: 4 } }, "· " + reset) : null
				)
			);
		}

		/** Hover text for a provider's figures: what each number means. */
		function providerTip(provider) {
			const lines = [];
			if (provider.remaining != null) lines.push(`剩余额度 ¥${provider.remaining}：当前还能用`);
			if (provider.granted != null) lines.push(`总额度 ${provider.granted}：账户累计获得，只增不减`);
			if (provider.spent != null) lines.push(`已用 ¥${provider.spent}：开户至今总消费`);
			if (provider.granted != null && provider.remaining != null) {
				lines.push(`关系：总额度 ${provider.granted} − 已用 ¥${provider.spent ?? '--'} = 剩余 ¥${provider.remaining}`);
			}
			if (provider.todaySpent != null) lines.push(`今日消费 ¥${provider.todaySpent}（当日 0 点起）`);
			return lines.join("\n");
		}

		/**
		 * Provider list editor: one card per relay, with add and remove.
		 *
		 * The whole list is posted at once, so adding, editing and deleting share
		 * a single save. Keys are write-only: the host answers only whether one is
		 * stored, never its value.
		 */
		/** 开关统一用 kit 的 Switch（36×20，和官方设置页同一个控件）。 */
		const pillSwitch = (checked, onToggle, title, disabled = false) =>
			react.createElement(Switch, { checked, onChange: onToggle, title, disabled });

		function ProviderSettings() {
			const prefs = useCodexPrefs();
			// Per-card visibility switch (same store the sidebar uses), so hiding here
			// takes effect immediately.
			const show = useShow();
			// 总开关：关掉后侧栏一张卡都不显示。
			const enabled = useEnabled();
			const [draft, setDraft] = useState(null);
			const [saving, setSaving] = useState(false);
			const [notice, setNotice] = useState("");

			/** Server provider -> edit model. The key is always re-entered. */
			const toDraft = (item) => ({
				id: item.id,
				kind: item.kind === "codex" ? "codex" : "relay",
				name: item.name || "",
				baseUrl: item.baseUrl || "",
				balanceUrl: item.balanceUrl || "",
				credential: item.credential || "",
				apiKey: "",
				hasApiKey: Boolean(item.hasApiKey),
				map: {
					spent: { path: item.map?.spent?.path || "", scale: item.map?.spent?.scale ?? 0.01 },
					granted: { path: item.map?.granted?.path || "", scale: item.map?.granted?.scale ?? 1 },
					remaining: { path: item.map?.remaining?.path || "", scale: item.map?.remaining?.scale ?? 1 },
				},
			});

			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const response = await fetch("/dsh-quota/api/settings", { cache: "no-store" });
						const data = await response.json();
						if (!alive) return;
						setDraft((data.providers || []).map(toDraft));
					} catch {
						if (!alive) return;
						setDraft([]);
						setNotice("读取失败");
					}
				})();
				return () => { alive = false };
			}, []);

			const patchProvider = (id, key, value) =>
				setDraft((list) => (list || []).map((item) => (item.id === id ? { ...item, [key]: value } : item)));
			const removeProvider = (id) => setDraft((list) => (list || []).filter((item) => item.id !== id));
			/** Drag-to-reorder: the array order is what the sidebar renders. */
			const moveProvider = (from, to) => setDraft((list) => {
				const next = [...(list || [])];
				if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
				const [moved] = next.splice(from, 1);
				next.splice(to, 0, moved);
				return next;
			});
			/**
			 * One-click provider templates, shown before the blank "+ 供应商" and
			 * sorted by label. Each fills in everything that is easy to get wrong
			 * (endpoint + field paths); a key is still the user's to enter.
			 * Add an entry here to offer another preset.
			 */
			const PRESETS = [
				{ id: "codex", label: "Codex", kind: "codex", name: "Codex" },
				{
					id: "astra-hub",
					label: "AstraHub",
					kind: "relay",
					name: "AstraHub",
					// Standard new-api site: the pair of billing paths is implied.
					baseUrl: "https://www.astrahub-ai.com",
					map: {
						spent: { path: "usage.total_usage", scale: 0.01 },
						granted: { path: "subscription.hard_limit_usd", scale: 1 },
						remaining: { path: "", scale: 1 },
					},
				},
				{
					id: "deepseek",
					label: "DeepSeek",
					kind: "relay",
					name: "DeepSeek",
					// The URL carries the endpoint, so a single field says everything.
					baseUrl: "https://api.deepseek.com/user/balance",
					map: {
						spent: { path: "", scale: 0.01 },
						granted: { path: "", scale: 1 },
						remaining: { path: "balance_infos.0.total_balance", scale: 1 },
					},
				},
				{
					id: "zai",
					label: "Z.AI",
					kind: "relay",
					// Standard API account on the China station: cash balance, not a
					// Coding Plan quota. The 3 fields come straight from its report API.
					name: "智谱 Z.AI",
					baseUrl: "https://open.bigmodel.cn/api/biz/account/query-customer-account-report",
					map: {
						spent: { path: "data.totalSpendAmount", scale: 1 },
						granted: { path: "data.rechargeAmount", scale: 1 },
						remaining: { path: "data.availableBalance", scale: 1 },
					},
				},
			].sort((left, right) => left.label.localeCompare(right.label, "en"));

			const addProvider = (kind, preset = null) => {
				const id = `new-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
				setDraft((list) => [...(list || []), {
					id,
					kind: preset?.kind || kind,
					name: preset?.name || "",
					baseUrl: preset?.baseUrl || "",
					balanceUrl: preset?.balanceUrl || "",
					credential: "",
					apiKey: "",
					hasApiKey: false,
					...(preset?.map ? { map: preset.map } : {}),
				}]);
				// A brand-new card opens so its fields are right there.
				setOpen((prev) => ({ ...prev, [id]: true }));
			};

			const save = async () => {
				setSaving(true);
				setNotice("");
				try {
					const response = await fetch("/dsh-quota/api/settings", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							providers: (draft || []).map((item) => ({
								id: item.id,
								kind: item.kind,
								name: item.name,
								baseUrl: item.baseUrl,
								balanceUrl: item.balanceUrl,
								credential: item.credential,
								// Empty means "keep the stored key".
								apiKey: item.apiKey,
								// Empty paths fall back to the presets on the host.
								map: item.map,
							})),
						}),
					});
					if (!response.ok) throw new Error(String(response.status));
					const data = await response.json();
					setDraft((data.providers || []).map(toDraft));
					setNotice("已保存");
				} catch {
					setNotice("保存失败");
				} finally {
					setSaving(false);
				}
			};

			// Per-provider probe state: the raw response the user asked to see.
			const [probe, setProbe] = useState({});
			const [openMap, setOpenMap] = useState({});
			// Which provider cards are expanded. Everything starts collapsed.
			const [open, setOpen] = useState({});
			// Index of the card being dragged (null when idle).
			const [dragIndex, setDragIndex] = useState(null);
			// Which add button the pointer is over (id of the preset, or "custom").
			const [hoverAdd, setHoverAdd] = useState(null);

			const patchMap = (id, field, key, value) =>
				setDraft((list) => (list || []).map((item) => (item.id === id
					? { ...item, map: { ...item.map, [field]: { ...item.map?.[field], [key]: value } } }
					: item)));

			const runProbe = async (provider) => {
				setProbe((prev) => ({ ...prev, [provider.id]: { loading: true } }));
				try {
					const response = await fetch("/dsh-quota/api/probe", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							providerId: provider.id,
							baseUrl: provider.baseUrl,
							balanceUrl: provider.balanceUrl,
							apiKey: provider.apiKey,
							map: provider.map,
						}),
					});
					const data = await response.json();
					setProbe((prev) => ({ ...prev, [provider.id]: { loading: false, ok: response.ok, data } }));
				} catch (error) {
					setProbe((prev) => ({ ...prev, [provider.id]: { loading: false, ok: false, data: { error: String(error && error.message) } } }));
				}
			};

			/**
			 * Add button, copied from the app's own `creatorButton` / `addButton`:
			 * 1px dashed border-l3, radius lg (16), height 44, 14px text, centered,
			 * and it stretches to share the row (`flex: 1 1 0`).
			 */
			const addButtonStyle = (disabled, hovered = false) => ({
				boxSizing: "border-box",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 6,
				// Equal share of the row: five buttons (4 presets + 自定义) fit one line.
				flex: "1 1 0",
				minWidth: 92,
				height: 40,
				padding: "0 8px",
				borderRadius: "var(--dsw-radius-lg, 16px)",
				// Inline styles cannot express :hover, so the row tracks it in state.
				border: `1px dashed ${hovered && !disabled
					? "var(--dsw-alias-border-l4, #ffffff40)"
					: "var(--dsw-alias-border-l3, #ffffff26)"}`,
				background: hovered && !disabled
					? "var(--dsw-alias-interactive-bg-hover, #ffffff14)"
					: "transparent",
				color: TEXT_1,
				fontSize: 13,
				lineHeight: "20px",
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.5 : 1,
				transition: "background-color .12s var(--ds-ease-in-out, ease-in-out), border-color .12s var(--ds-ease-in-out, ease-in-out)",
			});

			/** Inline secondary action (字段映射 / 获取返回): outlined, not stretched. */
			// One control per row, DSH style: label above a full-width input.
			const rowStyle = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };
			const rowLabelStyle = { flex: "none", fontSize: 13, lineHeight: "18px", color: TEXT_2 };

			const field = (provider, text, key, extra = {}) => react.createElement(
				"label",
				{ style: rowStyle },
				react.createElement("span", { style: rowLabelStyle }, text),
				react.createElement(Input, {
					type: extra.type || "text",
					value: provider[key] || "",
					placeholder: extra.placeholder || "",
					width: "100%",
					onChange: (value) => patchProvider(provider.id, key, value),
				})
			);

			/**
			 * Optional field mapping. Fetch first, look at the real JSON, then point
			 * each displayed number at a path. Left empty, the presets apply.
			 */
			const mappingSection = (provider) => {
				const open = Boolean(openMap[provider.id]);
				const state = probe[provider.id] || null;
				const data = state?.data || null;
				const amounts = data?.amounts;
				const fmt = (value) => (value === null || value === undefined ? "—" : `¥${Number(value).toFixed(2)}`);
				const pathField = (field, label, note) => react.createElement(
					"label",
					{ style: rowStyle },
					react.createElement("span", { style: rowLabelStyle }, label),
					react.createElement(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", minWidth: 0 } },
						react.createElement(
							"div",
							{ style: { flex: "1 1 auto", minWidth: 0 } },
							react.createElement(Input, {
								value: provider.map?.[field]?.path || "",
								placeholder: note || "",
								width: "100%",
								onChange: (value) => patchMap(provider.id, field, "path", value),
							})
						),
						react.createElement(Input, {
							type: "number",
							step: "any",
							value: provider.map?.[field]?.scale ?? "",
							width: 76,
							onChange: (value) => patchMap(provider.id, field, "scale", Number(value)),
						})
					)
				);

				return react.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 } },
					// Both actions on one line, like the app's own button rows.
					react.createElement(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						react.createElement(
							Button,
							{
								variant: "secondary",
								onClick: () => setOpenMap((prev) => ({ ...prev, [provider.id]: !open })),
							},
							open ? "字段映射 ▲" : "字段映射（可选）▼"
						),
						open && react.createElement(
							Button,
							{
								variant: "secondary",
								onClick: () => runProbe(provider),
								disabled: Boolean(state?.loading),
							},
							state?.loading ? "请求中…" : "获取返回"
						)
					),
					!open ? null : react.createElement(
						react.Fragment,
						null,
						react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: TEXT_2 } },
							"先看返回的字段名，再填到下面；留空就用默认。例：DeepSeek 官方把「剩余」填成 balance_infos.0.total_balance。"),
						state && !state.loading && !data?.combined
							? react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary, #ff6262)" } },
								`请求失败：${data?.error || "没有返回"}`)
							: null,
						data?.combined
							? react.createElement(
								"pre",
								{
									style: {
										margin: 0,
										maxHeight: 140,
										overflow: "auto",
										padding: "10px 12px",
										borderRadius: "var(--dsw-radius-md, 12px)",
										background: "var(--dsw-alias-bg-base, #151517)",
										border: ".5px solid var(--dsw-alias-border-l3)",
										color: TEXT_2,
										fontSize: 11,
										lineHeight: "16px",
										whiteSpace: "pre-wrap",
										wordBreak: "break-all",
									},
								},
								JSON.stringify(data.combined, null, 2)
							)
							: null,
						data?.errors?.usage || data?.errors?.subscription
							? react.createElement("span", { style: { fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, #adb2b8)" } },
								`部分接口失败：${[
									data.errors.usage ? `usage(${data.errors.usage.status || "无响应"})` : "",
									data.errors.subscription ? `subscription(${data.errors.subscription.status || "无响应"})` : "",
								].filter(Boolean).join("、")}`)
							: null,
						pathField("spent", "已用", "usage.total_usage"),
						pathField("granted", "总额", "subscription.hard_limit_usd"),
						pathField("remaining", "剩余", "留空 = 总额 − 已用"),
						amounts
							? react.createElement("span", { style: { fontSize: 11, lineHeight: "16px", color: TEXT_2 } },
								`按当前映射解析：已用 ${fmt(amounts.spent)} · 总额度 ${fmt(amounts.granted)} · 剩余 ${fmt(amounts.remaining)}`)
							: null,
						react.createElement(
							"div",
							{ style: { alignSelf: "flex-start" } },
							react.createElement(
								Button,
								{
									variant: "secondary",
									onClick: () => setDraft((list) => (list || []).map((item) => (item.id === provider.id
										? { ...item, map: { spent: { path: "", scale: 0.01 }, granted: { path: "", scale: 1 }, remaining: { path: "", scale: 1 } } }
										: item))),
								},
								"恢复默认"
							)
						)
					)
				);
			};

			/**
			 * Codex card display switches. Nothing here is sent to the host: they only
			 * decide which of the four numbers the sidebar card renders.
			 */
			/** Trash icon: the app's delete affordance is an icon, never a word. */
			const trashIcon = react.createElement(
				"svg",
				{
					width: 15,
					height: 15,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				react.createElement("path", { d: "M3 6h18" }),
				react.createElement("path", { d: "M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" }),
				react.createElement("path", { d: "M18.5 6l-.9 13a1.5 1.5 0 0 1-1.5 1.4H7.9a1.5 1.5 0 0 1-1.5-1.4L5.5 6" }),
				react.createElement("path", { d: "M10 10.5v6M14 10.5v6" })
			);


			const codexSwitches = () => {
				// One row per switch: label left, pill right — kit SettingRow keeps the rhythm.
				const pref = (label, key) => react.createElement(
					SettingRow,
					{ label },
					pillSwitch(Boolean(prefs[key]), () => codexPrefs.set({ ...prefs, [key]: !prefs[key] }), label)
				);
				return react.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 } },
					react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: TEXT_2 } }, "侧栏这张卡显示哪些内容，改完立即生效："),
					pref("5 小时额度", "fiveHour"),
					pref("周额度", "weekly"),
					pref("重置时间", "reset"),
					pref("重置次数", "resets")
				);
			};

			const card = (provider, index) => {
				const isCodex = provider.kind === "codex";
				const expanded = Boolean(open[provider.id]);
				const summary = isCodex ? "本机 Codex CLI" : (provider.baseUrl || "未填地址");
				const displayName = provider.name || (isCodex ? "Codex" : "未命名供应商");
				// Fixed-width gutter so the name and every field label share one column.
				const GUTTER = 22;
				const grip = react.createElement(
					"span",
					{
						draggable: true,
						title: "拖动调整顺序",
						onDragStart: (event) => {
							event.dataTransfer.effectAllowed = "move";
							event.dataTransfer.setData("text/plain", provider.id);
							setDragIndex(index);
						},
						onDragEnd: () => setDragIndex(null),
						style: { flex: "0 0 auto", width: 14, textAlign: "center", cursor: "grab", color: TEXT_2, fontSize: 12, lineHeight: "16px", userSelect: "none" },
					},
					"⠿"
				);
				return react.createElement(
					"div",
					{
						key: provider.id,
						onDragOver: (event) => {
							if (dragIndex === null || dragIndex === index) return;
							event.preventDefault();
							moveProvider(dragIndex, index);
							setDragIndex(index);
						},
						onDrop: (event) => {
							event.preventDefault();
							setDragIndex(null);
						},
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 14,
							padding: "14px 16px",
							borderRadius: "var(--dsw-radius-xl, 20px)",
							border: ".5px solid var(--dsw-alias-settings-card-stroke, #fff3)",
							background: "var(--dsw-alias-settings-card-fill, #2c2c2e)",
							minWidth: 0,
							opacity: dragIndex === index ? 0.55 : 1,
						},
					},
					// Header: grip · name · summary ……… 删除 ▸
					react.createElement(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
						grip,
						react.createElement(
							"button",
							{
								type: "button",
								onClick: () => setOpen((prev) => ({ ...prev, [provider.id]: !expanded })),
								"aria-expanded": expanded,
								title: expanded ? "收起" : "展开",
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									flex: "1 1 auto",
									minWidth: 0,
									padding: 0,
									border: "none",
									background: "transparent",
									color: "inherit",
									cursor: "pointer",
									textAlign: "left",
								},
							},
							react.createElement("span", { style: { ...blockHead, fontSize: 15, lineHeight: "20px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, displayName),
							react.createElement("span", { style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, lineHeight: "16px", color: TEXT_2 } }, summary)
						),
						// Visibility switch: no label, sits just before 删除. Any card
						// may be hidden — 全部关掉后侧栏一张卡都不显示。
						pillSwitch(
							show[provider.id] !== false,
							() => showStore.set({ ...show, [provider.id]: show[provider.id] !== false ? false : true }),
							show[provider.id] === false ? "在侧栏显示" : "在侧栏隐藏",
						),
						react.createElement(
							"button",
							{
								type: "button",
								onClick: () => removeProvider(provider.id),
								title: "删除",
								"aria-label": "删除",
								style: {
									flex: "none",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									width: 22,
									height: 22,
									border: "none",
									background: "transparent",
									color: "var(--dsw-alias-label-tertiary, #adb2b8)",
									padding: 0,
									borderRadius: "var(--dsw-radius-sm, 8px)",
									cursor: "pointer",
								},
							},
							trashIcon
						),
						react.createElement("span", { style: { flex: "0 0 auto", width: 12, textAlign: "center", fontSize: 10, lineHeight: "14px", color: TEXT_2 } }, expanded ? "▾" : "▸")
					),
					!expanded ? null : react.createElement(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: 14, minWidth: 0, paddingLeft: GUTTER } },
						isCodex
							? react.createElement(
								react.Fragment,
								null,
								// Several Codex cards are allowed, so the name is editable —
								// that is how two accounts stay apart.
								field(provider, "名称", "name", { placeholder: "例如 Codex 工作号" }),
								codexSwitches()
							)
							: react.createElement(
								react.Fragment,
								null,
								// Examples come from the DeepSeek preset: that is the flow most
								// people start with, and it shows a single-endpoint URL.
								field(provider, "名称", "name", { placeholder: "例如 DeepSeek" }),
								field(provider, "地址", "baseUrl", {
									placeholder: "https://api.deepseek.com/user/balance",
									title: "只填域名 → new-api 两段式（自动补 /dashboard/billing/usage 与 /subscription）；填一个带路径的地址 → 只请求它；填两个地址（空格分隔）→ 依次作为「用量」和「总额度」接口",
								}),
								field(provider, "API Key", "apiKey", {
									type: "password",
									placeholder: provider.hasApiKey ? "已设置，留空则不改" : "sk-...",
									title: "保存在本机，不会回传到浏览器",
								}),
								mappingSection(provider)
							)
					)
				);
			};

			const list = draft || [];
			// Array order IS the display order: the sidebar renders the same sequence,
			// and dragging the grip rewrites it. No kind-based sorting any more.
			// Presets are never hidden: several cards of the same kind are allowed
			// (e.g. two accounts of one relay), each with its own name.
			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 } },
				// 总开关放最上面：一键关掉全部面板，下面的供应商配置原样保留。
				react.createElement(
					SettingsCard,
					null,
					react.createElement(
						SettingRow,
						{
							label: "在侧栏显示额度面板",
							hint: "关掉后一张卡都不显示，下面的配置和开关全部保留",
						},
						pillSwitch(enabled, () => enabledStore.set(!enabled), "在侧栏显示额度面板")
					)
				),
				list.length === 0
					? react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: TEXT_2 } }, "还没有供应商，点下面的按钮添加。")
					: list.map(card),
				react.createElement(
					"div",
					{ style: { display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0 } },
					// Presets first (alphabetical), then the blank custom provider. Each
					// preset can be added any number of times (one per account).
					PRESETS.map((preset) => react.createElement(
						"button",
						{
							key: preset.id,
							type: "button",
							onClick: () => addProvider(preset.kind || "relay", preset),
							onMouseEnter: () => setHoverAdd(preset.id),
							onMouseLeave: () => setHoverAdd((prev) => (prev === preset.id ? null : prev)),
							title: preset.kind === "codex"
								? "加一张 Codex 卡（读取本机 Codex CLI 额度，可改名称区分账号）"
								: `加一个预填好的 ${preset.label} 供应商（地址与字段路径已填，只需补 Key 和名称）`,
							style: addButtonStyle(false, hoverAdd === preset.id),
						},
						preset.label
					)),
					react.createElement(
						"button",
						{
							type: "button",
							onClick: () => addProvider("relay"),
							onMouseEnter: () => setHoverAdd("custom"),
							onMouseLeave: () => setHoverAdd((prev) => (prev === "custom" ? null : prev)),
							style: addButtonStyle(false, hoverAdd === "custom"),
						},
						"+ 自定义"
					)
				),
				react.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } },
					react.createElement("span", { style: { flex: "1 1 auto" } }),
					notice && react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: TEXT_2 } }, notice),
					react.createElement(
						Button,
						{
							onClick: save,
							disabled: Boolean(saving),
						},
						saving ? "保存中…" : "保存"
					)
				)
			);
		}

		/** The settings-modal section (设置 面板左侧导航新增一项). */
		function QuotaSettingsSection() {
			// Header mirrors the app's own settings pages: kit Section gives the same
			// big title + one-line description, so this stays in sync with the app.
			return react.createElement(
				Section,
				{
					title: "额度看板",
					description: "侧栏每张卡片显示一个供应商的余额；Codex 读取本机 CLI，其余走各自接口。",
				},
				react.createElement(ProviderSettings, null)
			);
		}

		/**
		 * 官方悬浮卡样式的信息卡：卡片填充色、20px 圆角、标题 + 说明 + 键值行。
		 * 悬停卡片与状态栏弹层共用。
		 */
		function InfoCard({ title, subtitle, rows, left, top, below, onMount }) {
			return createPortal(
				react.createElement(
					"div",
					{
						ref: onMount || undefined,
						style: {
							position: "fixed",
							left,
							top,
							transform: below ? "none" : "translateY(-100%)",
							zIndex: 2147400000,
							width: 248,
							boxSizing: "border-box",
							padding: "12px 14px",
							borderRadius: "var(--dsw-radius-xl, 20px)",
							background: "var(--dsw-alias-settings-card-fill, #2c2c2e)",
							boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
							color: TEXT_1,
							pointerEvents: "none",
							display: "flex",
							flexDirection: "column",
						},
					},
					react.createElement("span", { style: { fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, title),
					subtitle && react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: TEXT_2, marginTop: 2 } }, subtitle),
					react.createElement(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 10 } },
						rows.map((row, index) => react.createElement(
							"div",
							{ key: index, style: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 } },
							react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: TEXT_2, flex: "0 0 auto" } }, row[0]),
							react.createElement("span", { style: { flex: "1 1 auto" } }),
							react.createElement("span", { style: { fontSize: 13, lineHeight: "18px", color: TEXT_1, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" } }, row[1])
						))
					)
				),
				document.body
			);
		}

		/** 把一张卡片的细节整理成「标签 / 值」行，悬停与状态栏共用同一份格式。 */
		function providerRows(provider, state) {
			const money = (value) => (value == null ? null : "¥" + value);
			const percent = (item) => (item?.remaining == null ? null : item.remaining + "%");
			if (provider.kind === "codex") {
				return [
					["5 小时", percent(state?.fiveHour) || "--"],
					["周", percent(state?.weekly) || "--"],
					["5 小时重置", state?.fiveHour?.reset || "--"],
					["周重置", state?.weekly?.reset || "--"],
					["重置次数", state?.resets == null ? "--" : String(state.resets)],
				];
			}
			return [
				["余额", money(provider.remaining) || "--"],
				["已用", money(provider.spent) || "--"],
				["总额", money(provider.granted) || "--"],
				["今日", money(provider.todaySpent) || "--"],
			].filter((row) => row[1] !== "--");
		}

		/** 侧栏卡片悬停时显示的详情，位置贴着卡片上沿。 */
		function HoverCard({ provider, state, rect }) {
			const width = 248;
			const viewportWidth = window.innerWidth || 1024;
			const viewportHeight = window.innerHeight || 768;
			const rows = providerRows(provider, state);
			// 和官方一致：贴在卡片右侧；右边放不下就翻到左侧。
			const rightSide = rect.right + 8;
			const left = rightSide + width + 8 <= viewportWidth
				? rightSide
				: Math.max(8, rect.left - width - 8);
			// 竖直夹取：估算卡片高度（标题 + 说明 + 若干键值行 + 内边距），
			// 底部放不下就往上顶，避免被窗口底边裁掉。
			const estimated = 64 + rows.length * 24;
			const baseTop = Math.max(8, Math.min(rect.top - 4, viewportHeight - estimated - 8));
			const [shift, setShift] = useState(0);
			// 挂载后用真实高度再修一次，估算偏小时把整卡上移。
			const measure = (node) => {
				if (!node) return;
				const height = node.getBoundingClientRect().height;
				const overflow = baseTop + height - (viewportHeight - 8);
				setShift(overflow > 0 ? overflow : 0);
			};
			return react.createElement(InfoCard, {
				title: provider.name || (provider.kind === "codex" ? "Codex" : "供应商"),
				subtitle: provider.kind === "codex" ? "本机 Codex CLI" : (provider.baseUrl || ""),
				rows,
				left,
				top: Math.max(8, baseTop - shift),
				below: true,
				onMount: measure,
			});
		}

		function QuotaFooter({ wide }) {
			const [state, setState] = useState(null);
			const [error, setError] = useState(false);
			// 鼠标悬停的卡片（key）与它的位置，用于显示官方样式的详情卡。
			const [hover, setHover] = useState(null);
			const show = useShow();
			const codexPref = useCodexPrefs();
			const enabled = useEnabled();

			const tick = useCallback(async () => {
				try {
					const r = await fetch("/dsh-quota/api/balance", { cache: "no-store" });
					if (!r.ok) throw new Error(String(r.status));
					setState(await r.json());
					setError(false);
				} catch {
					setError(true);
				}
			}, []);

			useEffect(() => {
				tick();
				const t = setInterval(tick, 5000);
				return () => clearInterval(t);
			}, [tick]);

			// A host older than the multi-provider change answers with a single
			// `astra` entry; degrade to one relay card instead of showing nothing.
			const providers = Array.isArray(state?.providers)
				? state.providers
				: state?.astra
					? [{ key: "astra-hub", kind: "relay", name: state.astra.name || "AstraHub", ...state.astra }]
					: [];
			const isShown = (key) => show[key] !== false;
			// 总开关关掉、或每张卡都被关掉时，侧栏留白都不占：直接不渲染。
			const listed = providers.filter((provider) => isShown(provider.key));
			if (!enabled || listed.length === 0) return null;

			// Rail mode (sidebar collapsed): single status dot.
			if (!wide) {
				let worst = null;
				if (state) {
					const c = [];
					for (const provider of listed) {
						if (provider.kind === "codex") c.push(state.fiveHour?.color, state.weekly?.color);
						else c.push(provider.color);
					}
					const cc = c.filter(Boolean);
					if (cc.length) worst = cc.includes(STAT.bad) ? STAT.bad : cc.includes(STAT.warn) ? STAT.warn : STAT.ok;
				}
				return react.createElement(
					"div",
					{
						style: { display: "flex", justifyContent: "center", padding: "4px 0" },
					},
					react.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", backgroundColor: error ? STAT.bad : worst || STAT.off } })
				);
			}

			// One card per entry, sorted by display name so the order never depends
			// on the order the user added providers in. Both kinds are one line:
			// codex packs both windows and the reset count into a single row.
			const entries = [];
			for (const provider of listed) {
				if (provider.kind === "codex") {
					const name = provider.name || "Codex";
					// Each part can be switched off in 设置 → 额度看板 → Codex.
					const showFive = codexPref.fiveHour;
					const showWeekly = codexPref.weekly;
					const showReset = codexPref.reset;
					const showResets = codexPref.resets && state?.resets > 0;
					const percent = (item) => (item?.remaining == null ? "--" : item.remaining + "%");
					// Built exactly like a relay card: one baseline row with the dot, the
					// name and a numbers wrapper holding a 15px figure plus 10px detail
					// spans. Same styles ⇒ same baseline, same height, same centring.
					const parts = [];
					if (showFive) parts.push({ text: percent(state?.fiveHour), strong: true });
					if (showFive && showReset && state?.fiveHour?.reset) parts.push({ text: state.fiveHour.reset, strong: false, sep: "·" });
					if (showWeekly) parts.push({ text: percent(state?.weekly), strong: true, sep: "/" });
					if (showWeekly && showReset && state?.weekly?.reset) parts.push({ text: state.weekly.reset, strong: false, sep: "·" });
					if (showResets) parts.push({ text: String(state.resets), strong: false, sep: "·" });
					entries.push({
						name,
						node: react.createElement(
							"div",
							{
								key: provider.key,
								onMouseEnter: (event) => setHover({ key: provider.key, rect: event.currentTarget.getBoundingClientRect() }),
								onMouseLeave: () => setHover(null),
								style: { ...groupStyle, padding: CARD_PAD, flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0, overflow: "hidden" },
							},
							react.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", backgroundColor: state?.fiveHour?.color || STAT.off, flex: "0 0 auto", alignSelf: "center", transform: "translateY(1.5px)" } }),
							react.createElement("span", { style: { ...blockHead, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } }, name),
							react.createElement(
								"span",
								{ style: { display: "flex", alignItems: "baseline", gap: 0, flex: "0 0 auto" } },
								parts.map((part, index) => react.createElement(
									react.Fragment,
									{ key: index },
									part.sep && react.createElement(
										"span",
										{ style: { fontSize: 10, lineHeight: "13px", color: TEXT_2, flex: "none", letterSpacing: "-0.4px", margin: 0 } },
										part.sep
									),
									react.createElement(
										"span",
										{
											style: part.strong
												? { ...num, fontSize: 15, fontWeight: 600, lineHeight: "20px", color: TEXT_1 }
												: { fontSize: 10, lineHeight: "13px", color: TEXT_2, whiteSpace: "nowrap" },
										},
										part.text
									)
								))
							)
						),
					});
					continue;
				}
				const name = provider.name || "供应商";
				// Balance and the granted total on the same line as the name: no
				// labels, just "¥198" or "¥198 / 391" when a total is known.
				const showTotal = provider.granted != null;
				entries.push({
					name,
					node: react.createElement(
						"div",
						{
						key: provider.key,
						onMouseEnter: (event) => setHover({ key: provider.key, rect: event.currentTarget.getBoundingClientRect() }),
						onMouseLeave: () => setHover(null),
						style: { ...groupStyle, padding: CARD_PAD, flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0, overflow: "hidden" },
					},
						// Flat row: the dot must NOT sit inside a wrapper with the name —
						// a flex wrapper takes its baseline from the dot's bottom edge, which
						// pushed the name out of line with the amount.
						react.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", backgroundColor: provider.color || STAT.off, flex: "0 0 auto", alignSelf: "center", transform: "translateY(1.5px)" } }),
						// blockHead carries flex:none, which would stop the name from
						// shrinking and let it run under the number. Override it.
						react.createElement("span", { style: { ...blockHead, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } }, name),
						react.createElement(
							"span",
							{ style: { display: "flex", alignItems: "baseline", gap: 4, flex: "0 0 auto" } },
							react.createElement("span", { style: { ...num, fontSize: 15, fontWeight: 600, lineHeight: "20px", color: TEXT_1 } },
								provider.remaining == null ? "--" : "¥" + provider.remaining),
							showTotal && react.createElement("span", { style: { fontSize: 10, lineHeight: "13px", color: TEXT_2 } }, "/ " + provider.granted)
						)
					),
				});
			}
			// No sorting: the card order is the provider order saved on the host,
			// which the settings page lets the user drag around.
			const cards = entries.map((entry) => entry.node);

			// Embedded panel — stretches the full sidebar width. No visible
			// controls: right-click anywhere on it to open the display settings.
			return react.createElement(
				"div",
				{
					style: { display: "flex", flexDirection: "column", width: "100%", minWidth: 0, padding: `0 ${PANEL_INSET}px 2px`, boxSizing: "border-box", },
				},
				react.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: CARD_GAP, minWidth: 0 } },
					cards,
					error && react.createElement("span", { style: { ...label, paddingLeft: 12 } }, "额度不可用")
				),
				hover && (() => {
					const provider = providers.find((item) => item.key === hover.key);
					return provider ? react.createElement(HoverCard, { provider, state, rect: hover.rect }) : null;
				})()
			);
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Two seats: the sidebar widget, and a section in the settings modal
		 * (`settings.section`, the same list-slot shape the sidebar seat uses).
		 * The page label is what the modal's left navigation shows.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register({ id: "dsh-quota-panel", name: "sidebar.footer.action" }, QuotaFooter)
			);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						id: "quota-panel",
						name: "settings.section",
						order: 50,
						label: () => "额度看板",
					},
					QuotaSettingsSection
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
