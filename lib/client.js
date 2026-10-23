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

		const STAT = { ok: "#43c982", warn: "#efb83f", bad: "#ff6262", off: "#6b7078" };
		// Wide enough for a provider name, clamped to the viewport on open.
		const MENU_WIDTH = 132;
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

		/** Filled input, matching the app's own settings fields. */
		const settingsInputStyle = {
			width: "100%",
			boxSizing: "border-box",
			height: 44,
			padding: "0 12px",
			borderRadius: "var(--dsw-radius-md, 12px)",
			border: ".5px solid var(--dsw-alias-settings-card-stroke, #ffffff26)",
			background: "var(--dsw-alias-bg-layer-1, #1b1b1c)",
			color: TEXT_1,
			fontSize: 14,
			lineHeight: "22px",
			outline: "none",
		};

		/**
		 * Provider list editor: one card per relay, with add and remove.
		 *
		 * The whole list is posted at once, so adding, editing and deleting share
		 * a single save. Keys are write-only: the host answers only whether one is
		 * stored, never its value.
		 */
		function ProviderSettings() {
			const prefs = useCodexPrefs();
			// Per-card visibility switch (same store the sidebar and the right-click
			// menu use), so hiding here takes effect immediately.
			const show = useShow();
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
			const secondaryButtonStyle = (disabled) => ({
				boxSizing: "border-box",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 6,
				flex: "0 0 auto",
				height: 36,
				padding: "0 14px",
				borderRadius: "var(--dsw-radius-md, 12px)",
				border: ".5px solid var(--dsw-alias-border-l4, #ffffff29)",
				background: "transparent",
				color: TEXT_1,
				fontSize: 14,
				lineHeight: "22px",
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.5 : 1,
			});

			// One control per row, DSH style: label above a full-width input.
			const rowStyle = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };
			const rowLabelStyle = { flex: "none", fontSize: 13, lineHeight: "18px", color: TEXT_2 };

			const field = (provider, text, key, extra = {}) => react.createElement(
				"label",
				{ style: rowStyle },
				react.createElement("span", { style: rowLabelStyle }, text),
				react.createElement("input", {
					type: extra.type || "text",
					value: provider[key] || "",
					placeholder: extra.placeholder,
					title: extra.title,
					"aria-label": text,
					onChange: (event) => patchProvider(provider.id, key, event.target.value),
					style: settingsInputStyle,
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
						react.createElement("input", {
							value: provider.map?.[field]?.path || "",
							placeholder: note,
							"aria-label": `${label}字段路径`,
							onChange: (event) => patchMap(provider.id, field, "path", event.target.value),
							style: { ...settingsInputStyle, height: 36, fontSize: 13, flex: "1 1 auto", minWidth: 0 },
						}),
						react.createElement("input", {
							type: "number",
							step: "any",
							value: provider.map?.[field]?.scale ?? "",
							title: "乘以这个系数换算成金额",
							"aria-label": `${label}系数`,
							onChange: (event) => patchMap(provider.id, field, "scale", Number(event.target.value)),
							style: { ...settingsInputStyle, height: 36, fontSize: 13, width: 76, flex: "none" },
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
							"button",
							{
								type: "button",
								onClick: () => setOpenMap((prev) => ({ ...prev, [provider.id]: !open })),
								style: secondaryButtonStyle(false),
							},
							open ? "字段映射 ▲" : "字段映射（可选）▼"
						),
						open && react.createElement(
							"button",
							{
								type: "button",
								onClick: () => runProbe(provider),
								disabled: state?.loading,
								style: secondaryButtonStyle(state?.loading),
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
							"button",
							{
								type: "button",
								onClick: () => setDraft((list) => (list || []).map((item) => (item.id === provider.id
									? { ...item, map: { spent: { path: "", scale: 0.01 }, granted: { path: "", scale: 1 }, remaining: { path: "", scale: 1 } } }
									: item))),
								style: { ...secondaryButtonStyle(false), alignSelf: "flex-start" },
							},
							"恢复默认"
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

			/**
			 * Switch, copied from the app's own control:
			 *   36x20 track, padding 2, radius 999, corner-shape round,
			 *   track --dsw-alias-border-l3 / [on] --dsw-alias-brand-primary,
			 *   16px thumb, corner-shape round, --dsw-alias-switch-thumb.
			 * `cornerShape: round` matters: the app sets superellipse globally, and
			 * without this override the pill renders as a squircle.
			 */
			const pillSwitch = (checked, onToggle, title, disabled = false) => react.createElement(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": checked,
					disabled,
					onClick: onToggle,
					title,
					style: {
						boxSizing: "border-box",
						position: "relative",
						flex: "0 0 auto",
						width: 36,
						height: 20,
						padding: 2,
						border: 0,
						borderRadius: 999,
						cornerShape: "round",
						cursor: disabled ? "default" : "pointer",
						opacity: disabled ? 0.5 : 1,
						display: "flex",
						alignItems: "center",
						justifyContent: checked ? "flex-end" : "flex-start",
						transition: "background-color .12s var(--ds-ease-in-out, ease-in-out)",
						backgroundColor: checked
							? "var(--dsw-alias-button-primary-fill, #f9fafb)"
							: "var(--dsw-alias-border-l3, #4a4a4d)",
					},
				},
				react.createElement("span", {
					style: {
						display: "block",
						width: 16,
						height: 16,
						borderRadius: "50%",
						cornerShape: "round",
						// Contrast in both states: dark knob on the white track, white knob
						// on the grey one. (The app's single --dsw-alias-switch-thumb token
						// lands mid-grey here and washes the control out.)
						backgroundColor: checked
							? "var(--dsw-alias-label-primary-foreground, #0f1115)"
							: "var(--dsw-alias-label-primary, #f9fafb)",
						transition: "background-color .12s ease",
					},
				})
			);

			const codexSwitches = () => {
				// One row per switch: label left, pill right — same rhythm as the app.
				const pref = (label, key) => react.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0 } },
					react.createElement("span", { style: { fontSize: 13, lineHeight: "18px", color: TEXT_1 } }, label),
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
						// Visibility switch: no label, sits just before 删除. Hiding the
						// last visible card is refused, same rule as the right-click menu.
						pillSwitch(
							show[provider.id] !== false,
							() => {
								const visible = show[provider.id] !== false;
								if (visible && shownCount <= 1) return;
								showStore.set({ ...show, [provider.id]: !visible });
							},
							show[provider.id] === false
								? "在侧栏显示"
								: (shownCount <= 1 ? "至少保留一张卡显示" : "在侧栏隐藏"),
							show[provider.id] !== false && shownCount <= 1,
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
			// How many cards the sidebar currently shows: the switch locks the last one.
			const shownCount = list.filter((item) => show[item.id] !== false).length;
			// Array order IS the display order: the sidebar renders the same sequence,
			// and dragging the grip rewrites it. No kind-based sorting any more.
			// Presets are never hidden: several cards of the same kind are allowed
			// (e.g. two accounts of one relay), each with its own name.
			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 } },
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
						"button",
						{
							type: "button",
							onClick: save,
							disabled: saving,
							style: {
								boxSizing: "border-box",
								height: 36,
								padding: "0 16px",
								borderRadius: "var(--dsw-radius-md, 12px)",
								border: "none",
								// Primary action, same tokens as the app's own save button.
								background: "var(--dsw-alias-button-primary-fill, #f9fafb)",
								color: "var(--dsw-alias-label-primary-foreground, #0f1115)",
								fontSize: 14,
								lineHeight: "22px",
								fontWeight: 500,
								cursor: saving ? "default" : "pointer",
								opacity: saving ? 0.6 : 1,
							},
						},
						saving ? "保存中…" : "保存"
					)
				)
			);
		}

		/** The settings-modal section (设置 面板左侧导航新增一项). */
		function QuotaSettingsSection() {
			// Header mirrors the app's own settings pages: big title + one-line
			// description, then sub-section labels inside the body.
			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 8, maxWidth: 640, minWidth: 0 } },
				react.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 } },
					react.createElement("span", {
						style: { fontSize: 18, fontWeight: 600, lineHeight: "26px", color: TEXT_1 },
					}, "额度看板"),
					react.createElement("span", {
						style: { fontSize: 13, lineHeight: "20px", color: TEXT_2 },
					}, "侧栏每张卡片显示一个供应商的余额；Codex 读取本机 CLI，其余走各自接口。")
				),
				react.createElement(ProviderSettings, null)
			);
		}

		function QuotaFooter({ wide }) {
			const [state, setState] = useState(null);
			const [error, setError] = useState(false);
			const show = useShow();
			const codexPref = useCodexPrefs();
			const [menuOpen, setMenuOpen] = useState(false);
			const [menuPos, setMenuPos] = useState(null);
			const menuRef = react.useRef(null);

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

			// Dismiss the popover on any click outside it, or Escape.
			useEffect(() => {
				if (!menuOpen) return;
				const onDown = (event) => {
					if (menuRef.current?.contains(event.target)) return;
					setMenuOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setMenuOpen(false);
				};
				document.addEventListener("mousedown", onDown, true);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown, true);
					document.removeEventListener("keydown", onKey);
				};
			}, [menuOpen]);

			// A host older than the multi-provider change answers with a single
			// `astra` entry; degrade to one relay card instead of showing nothing.
			const providers = Array.isArray(state?.providers)
				? state.providers
				: state?.astra
					? [{ key: "astra-hub", kind: "relay", name: state.astra.name || "AstraHub", ...state.astra }]
					: [];
			// Display menu: one entry per provider.
			// Absent means visible, so a newly added provider shows up by default.
			const menuItems = providers.map((provider) => ({ key: provider.key, label: provider.name }));
			const isShown = (key) => show[key] !== false;

			// The display-item popover opens on right-click, at the pointer.
			// Its size grows with the number of entries, so clamp against that.
			const onPanelContextMenu = (event) => {
				event.preventDefault();
				const width = MENU_WIDTH;
				const height = 16 + menuItems.length * 20;
				setMenuPos({
					left: Math.max(4, Math.min(event.clientX, window.innerWidth - width - 4)),
					top: Math.max(4, Math.min(event.clientY, window.innerHeight - height - 4)),
				});
				setMenuOpen(true);
			};

			const saveShow = (next) => showStore.set(next);
			// At least one item must stay visible, so the last shown one is
			// locked (its checkbox is rendered disabled).
			const checkedCount = menuItems.filter((item) => isShown(item.key)).length;
			const toggle = (key) => {
				const next = { ...show, [key]: !isShown(key) };
				if (!menuItems.some((item) => next[item.key] !== false)) return;
				saveShow(next);
			};

			// Rail mode (sidebar collapsed): single status dot.
			if (!wide) {
				let worst = null;
				if (state) {
					const c = [];
					for (const provider of providers) {
						if (!isShown(provider.key)) continue;
						if (provider.kind === "codex") c.push(state.fiveHour?.color, state.weekly?.color);
						else c.push(provider.color);
					}
					const cc = c.filter(Boolean);
					if (cc.length) worst = cc.includes(STAT.bad) ? STAT.bad : cc.includes(STAT.warn) ? STAT.warn : STAT.ok;
				}
				return react.createElement(
					"div",
					{
						style: { display: "flex", justifyContent: "center", padding: "4px 0", cursor: "context-menu" },
						title: "额度看板（右键设置显示项）",
						onContextMenu: onPanelContextMenu,
					},
					react.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", backgroundColor: error ? STAT.bad : worst || STAT.off } })
				);
			}

			// Floating settings popover (only this part floats). Built lazily: the
			// portal must not touch `document` until it is actually opened.
			const settingsFloat = !menuOpen ? null : createPortal(
				react.createElement(
					"div",
					{
						style: {
							position: "fixed",
							left: menuPos?.left ?? 8,
							top: menuPos?.top ?? 8,
							zIndex: 9999,
							display: "flex",
							flexDirection: "column",
							gap: 4,
							padding: "6px 8px",
							borderRadius: RADIUS_MD,
							// Solid surface so it reads as floating above the panel.
							background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #1c1c1f))",
							border: ".5px solid " + line,
							boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
							color: TEXT_1,
							fontSize: 12,
							width: MENU_WIDTH,
							boxSizing: "border-box",
						},
						ref: menuRef,
					},
					menuItems.map((item) => {
						// The last visible item cannot be unchecked.
						const shown = isShown(item.key);
						const locked = shown && checkedCount <= 1;
						return react.createElement(
							"label",
							{
								key: item.key,
								title: locked ? "至少保留一项" : undefined,
								style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, lineHeight: "18px", cursor: locked ? "not-allowed" : "pointer", padding: "1px 0", opacity: locked ? 0.65 : 1 },
							},
							react.createElement("input", {
								type: "checkbox",
								checked: shown,
								disabled: locked,
								onChange: () => toggle(item.key),
								style: { accentColor: "#43c982", width: 13, height: 13, flex: "none" },
							}),
							// Long provider names are cut short rather than widening the popover.
							react.createElement("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: item.label }, item.label)
						);
					})
				),
				document.body
			);

			// One card per entry, sorted by display name so the order never depends
			// on the order the user added providers in. Both kinds are one line:
			// codex packs both windows and the reset count into a single row.
			const entries = [];
			for (const provider of providers) {
				if (!isShown(provider.key)) continue;
				if (provider.kind === "codex") {
					const name = provider.name || "Codex";
					// Each part can be switched off in 设置 → 额度看板 → Codex.
					const showFive = codexPref.fiveHour;
					const showWeekly = codexPref.weekly;
					const showReset = codexPref.reset;
					const showResets = codexPref.resets && state?.resets > 0;
					const percent = (item) => (item?.remaining == null ? "--" : item.remaining + "%");
					// Layout: 62% · 21:43 / 61% · 10/27 16:35 · 3 次
					// Percentages are strong, everything after a separator is small.
					const segments = [];
					if (showFive) segments.push({ text: percent(state?.fiveHour), strong: true, sep: null });
					if (showFive && showReset && state?.fiveHour?.reset) {
						segments.push({ text: state.fiveHour.reset, strong: false, sep: "·" });
					}
					if (showWeekly) {
						segments.push({ text: percent(state?.weekly), strong: true, sep: segments.length ? "/" : null });
					}
					if (showWeekly && showReset && state?.weekly?.reset) {
						segments.push({ text: state.weekly.reset, strong: false, sep: "·" });
					}
					if (showResets) {
						segments.push({ text: String(state.resets), strong: false, sep: segments.length ? "·" : null });
					}
					entries.push({
						name,
						node: react.createElement(
							"div",
							{
								key: provider.key,
								style: {
								...groupStyle,
								// 固定高度 + 居中：混排 14px/8px 时 baseline 会让整行偏高，
								// 这里用和金额卡相同的 27px 卡高，内容强制垂直居中。
								padding: "0 12px",
								height: 27,
								boxSizing: "border-box",
								flexDirection: "row",
								alignItems: "center",
								gap: 0,
								minWidth: 0,
								overflow: "hidden",
							},
								title: [
									name,
									showFive
										? "5 小时 " + percent(state?.fiveHour)
											+ (showReset && state?.fiveHour?.reset ? "（" + state.fiveHour.reset + " 重置）" : "")
										: null,
									showWeekly
										? "周 " + percent(state?.weekly)
											+ (showReset && state?.weekly?.reset ? "（" + state.weekly.reset + " 重置）" : "")
										: null,
									showResets ? "重置次数 " + state.resets : null,
								].filter(Boolean).join(" · "),
							},
							react.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", backgroundColor: state?.fiveHour?.color || STAT.off, flex: "0 0 auto", alignSelf: "center", transform: "translateY(1.5px)", marginRight: 4 } }),
							react.createElement("span", { style: { ...blockHead, fontSize: 11, flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "20px", minWidth: 0, marginRight: 4 } }, name),
							
							react.createElement(
								"span",
								{
									style: {
										display: "flex",
										alignItems: "baseline",
										gap: 0,
										flex: "1 1 auto",
										justifyContent: "flex-end",
										minWidth: 0,
										whiteSpace: "nowrap",
										overflow: "hidden",
									},
								},
								segments.map((segment, index) => react.createElement(
									react.Fragment,
									{ key: index },
									segment.sep && react.createElement(
										"span",
										// Flex 会吃掉行内元素首尾的空格，必须用 margin 撑开间距。
										{ style: { fontSize: 8, lineHeight: "20px", color: TEXT_2, flex: "none", margin: segment.sep === "/" ? "0 3px" : "0 2px" } },
										segment.sep
									),
									react.createElement(
										"span",
										{
											style: segment.strong
												? { ...num, fontSize: 14, fontWeight: 600, lineHeight: "20px", color: TEXT_1, flex: "none" }
												: { fontSize: 9, lineHeight: "17px", color: TEXT_2, flex: "none" },
										},
										segment.text
									)
								))
							)
						),
					});
					continue;
				}
				const tip = providerTip(provider);
				const name = provider.name || "供应商";
				// Balance and the granted total on the same line as the name: no
				// labels, just "¥198" or "¥198 / 391" when a total is known.
				const showTotal = provider.granted != null;
				entries.push({
					name,
					node: react.createElement(
						"div",
						{ key: provider.key, style: { ...groupStyle, padding: CARD_PAD, flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0, overflow: "hidden" } },
						// Flat row: the dot must NOT sit inside a wrapper with the name —
						// a flex wrapper takes its baseline from the dot's bottom edge, which
						// pushed the name out of line with the amount.
						react.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", backgroundColor: provider.color || STAT.off, flex: "0 0 auto", alignSelf: "center", transform: "translateY(1.5px)" } }),
						// blockHead carries flex:none, which would stop the name from
						// shrinking and let it run under the number. Override it.
						react.createElement("span", { title: name, style: { ...blockHead, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } }, name),
						react.createElement(
							"span",
							{ title: tip || undefined, style: { display: "flex", alignItems: "baseline", gap: 4, flex: "0 0 auto" } },
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
					style: { display: "flex", flexDirection: "column", width: "100%", minWidth: 0, padding: `0 ${PANEL_INSET}px 2px`, boxSizing: "border-box", cursor: "context-menu" },
					title: "额度看板（右键设置显示项）",
					onContextMenu: onPanelContextMenu,
				},
				react.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: CARD_GAP, minWidth: 0 } },
					cards,
					error && react.createElement("span", { style: { ...label, paddingLeft: 12 } }, "额度不可用")
				),
				menuOpen && settingsFloat
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
