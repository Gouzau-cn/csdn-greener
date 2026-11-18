// ==UserScript==
// @name         CSDN 极简化 + 防自动登录跳转
// @namespace    https://github.com/Gccc9
// @version      3.3.0
// @description  CSDN 博客/问答/论坛等子站极简化：拦截广告/关注/背景皮肤，保留推荐内容；阻止自动弹出登录框并 replace 跳转到 passport（返回键失效）
// @author       Gccc9（原脚本）/ 改进
// @match        *://*.csdn.net/*
// @match        *://csdn.net/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ==========================================================================
     * 0. 跳转根因（2026-11 实测 CSDN 博客）
     * --------------------------------------------------------------------------
     * 1) csdn-toolbar.js 注册滚动监听：滚动超过
     *      (文档高度 - 视口高度) * 50%
     *    时调用 window.csdn.loginBox.show()，并写入 needShowLoginBoxAuto cookie
     *    （有效期 6 小时，用于节流）。
     *
     * 2) csdn-login-box.js 的 show() 内部会 new s(options)，构造函数中调用 init()：
     *    - 当 uuid_tt_dd 超过 60 天且 user_page_view_times >= 2 时，请求
     *      passport.csdn.net/v1/login/abtest/version/get?taskId=515；
     *      若返回 exp1，则执行
     *        location.replace('https://passport.csdn.net/account/login?spm=...')
     *    - 若分流接口返回“整页登录”，则执行 window.location.href = routeUrl
     *    - 另外还有按时间/次数触发的自动弹出任务，同样走 loginBox.show()
     *
     * 3) https://passport.csdn.net/account/login 会 302 到
     *    https://passport.csdn.net/login?code=applets
     *
     * 4) location.replace / 302 会替换当前历史记录，所以浏览器“后退”
     *    回不到文章（实测跳转后 history.length 仍为 1）。
     *
     * 关键限制：Location 的 href / assign / replace 都是不可配置、不可写的
     * 自有属性（descriptor.configurable === false、writable === false），
     * 页面 JS 无法用 defineProperty 或赋值拦截。因此只能在源头阻止
     * loginBox.show() 被“自动”调用，而不是事后拦截跳转。
     * ========================================================================== */

    const HOST = location.hostname;
    const IS_BLOG = /(^|\.)blog\.csdn\.net$/.test(HOST);
    const IS_ASK = /(^|\.)ask\.csdn\.net$/.test(HOST);
    const IS_PASSPORT = HOST === 'passport.csdn.net';
    // 所有 CSDN 子站共用 csdn-toolbar.js / csdn-login-box.js，统一做自动登录拦截；
    // 内容/阅读类子站再做极简化、广告清理和背景处理。
    const IS_CSDN = /(^|\.)csdn\.net$/.test(HOST);
    const IS_CONTENT_SITE = IS_BLOG || IS_ASK ||
        /(^|\.)(bbs|download|edu|so|www)\.csdn\.net$/.test(HOST);

    /* ==========================================================================
     * 1. 用户手势检测
     * --------------------------------------------------------------------------
     * 只有用户主动点击/按键/触摸时，才允许登录框真正弹出（例如主动点“登录”）。
     * 滚动、定时器、滚动到底等都不算“用户同意登录”。
     * ========================================================================== */
    let lastGestureAt = 0;
    ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(function (type) {
        window.addEventListener(type, function () {
            lastGestureAt = Date.now();
        }, true);
    });

    function hasUserGesture() {
        return Date.now() - lastGestureAt < 2000;
    }

    /* ==========================================================================
     * 2. 轻量提示条
     * ========================================================================== */
    function showToast(text) {
        if (!document.documentElement || document.getElementById('csdn-guard-toast')) return;
        const el = document.createElement('div');
        el.id = 'csdn-guard-toast';
        el.textContent = text;
        el.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
            'z-index:2147483647', 'background:rgba(30,30,30,.92)', 'color:#fff',
            'padding:8px 16px', 'border-radius:6px', 'font-size:13px',
            'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif',
            'pointer-events:none', 'opacity:0', 'transition:opacity .2s',
            'box-shadow:0 4px 16px rgba(0,0,0,.25)'
        ].join(';');
        (document.body || document.documentElement).appendChild(el);
        requestAnimationFrame(function () { el.style.opacity = '1'; });
        setTimeout(function () {
            el.style.opacity = '0';
            setTimeout(function () { el.remove(); }, 250);
        }, 1800);
    }

    /* ==========================================================================
     * 3. 阻止自动登录框（核心防护）
     * --------------------------------------------------------------------------
     * 三层保护：
     *   a. 同步劫持 window.csdn 赋值，在 loginBox 被赋值的“同一帧”包装 show()；
     *   b. 把 needShowLoginBoxAuto 强制为 false（工具栏据此跳过滚动自动弹框）；
     *   c. 写入站点自带的 needShowLoginBoxAuto cookie（6 小时节流），双保险。
     * ========================================================================== */
    let loginBoxObject = null;

    function wrapLoginBox(lb) {
        if (!lb || lb.__csdnGuardWrapped || typeof lb.show !== 'function') return;
        const originalShow = lb.show;
        lb.show = function () {
            // 没有用户手势 => 滚动/定时器/A-B 任务触发的自动登录，直接忽略
            if (!hasUserGesture()) {
                console.info('[CSDN 防跳转] 已拦截自动登录框调用（滚动或定时器触发）');
                showToast('已阻止 CSDN 自动登录跳转');
                return Promise.resolve();
            }
            // 用户主动点击“登录”等场景，放行原有逻辑
            return originalShow.apply(this, arguments);
        };
        lb.__csdnGuardWrapped = true;
    }

    function trapCsdnObject(obj) {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;

        // ---- 3a. 强制关闭自动弹框开关 ----
        try {
            Object.defineProperty(obj, 'needShowLoginBoxAuto', {
                configurable: true,
                enumerable: true,
                get: function () { return false; },
                // 页面写入时忽略，保持恒为 false
                set: function () { /* noop */ }
            });
        } catch (e) { /* 属性被锁定时忽略 */ }

        // ---- 3b. 拦截 loginBox 赋值，第一时间包装 show ----
        try {
            // 如果已经存在 loginBox，先接住它
            const existing = obj.loginBox;
            if (existing) {
                loginBoxObject = existing;
                wrapLoginBox(existing);
            }
            Object.defineProperty(obj, 'loginBox', {
                configurable: true,
                enumerable: true,
                get: function () { return loginBoxObject; },
                set: function (lb) {
                    loginBoxObject = lb;
                    wrapLoginBox(lb);
                }
            });
        } catch (e) { /* 退化为下面的轮询兜底 */ }
    }

    function installLoginBoxGuard() {
        let csdnObject = null;

        // ---- 同步劫持 window.csdn ----
        try {
            // 先接住可能已经存在的对象，避免劫持后丢失
            const existingCsdn = window.csdn;
            Object.defineProperty(window, 'csdn', {
                configurable: true,
                get: function () { return csdnObject; },
                set: function (v) {
                    csdnObject = v;
                    trapCsdnObject(v);
                }
            });
            if (existingCsdn) {
                csdnObject = existingCsdn;
                trapCsdnObject(existingCsdn);
            }
        } catch (e) {
            // window.csdn 若已被锁定，走轮询兜底
            console.warn('[CSDN 防跳转] window.csdn 劫持失败，使用轮询模式', e);
        }

        // ---- 轮询兜底：loginBox 被重建 / 劫持失败时仍能包装 ----
        let ticks = 0;
        const timer = setInterval(function () {
            const lb = window.csdn && window.csdn.loginBox;
            if (lb) wrapLoginBox(lb);

            // 前 30 秒高频检查，之后降频到 3 秒一次，避免长期占用
            if (++ticks >= 100) {
                clearInterval(timer);
                setInterval(function () {
                    const late = window.csdn && window.csdn.loginBox;
                    if (late) wrapLoginBox(late);
                }, 3000);
            }
        }, 300);
    }

    // ---- 3c. 站点自带的节流 cookie：6 小时内不再自动弹登录框 ----
    function suppressAutoLoginBoxCookie() {
        try {
            document.cookie = 'needShowLoginBoxAuto=1; domain=.csdn.net; path=/; max-age=21600; SameSite=Lax';
        } catch (e) { /* cookie 写入失败时忽略 */ }
    }

    /* ==========================================================================
     * 4. 极简化样式（沿用并修正原脚本的规则）
     * ========================================================================== */
    const REMOVE_SELECTORS = [
        // ---------- 登录框 / 遮罩 / 复制限制提示 ----------
        '.passport-login-tip-container',
        '.passport-login-container',
        '.passport-login-container2',
        '.passport-login-mark',
        '.passport-login-box',
        '.__copy-currency-container',

        // ---------- 背景皮肤 / 广告位 ----------
        '.simple-ad-slot',
        '.simple-ad-slot__fixed',
        '.simple-ad-bg',
        '[id^="kp_box_"]',
        '.toolbar-advert',
        '.csdn-toolbar-creative-mp',
        '.pulllog-box',
        '#dmp_ad_58',
        '.recommend-ad-box',          // 推荐区里的广告（推荐文章本身保留）
        '.type_hot_word',
        '.article-ad',
        '.blog_top_ad',
        '.ad-top',
        '.ad-bottom',
        '.ad-box',
        '.adsbygoogle',
        'iframe[src*="pos.baidu.com"]',
        'iframe[src*="cpro.baidu.com"]',
        'iframe[src*="dup.baidustatic.com"]',
        'iframe[src*="gdt.qq.com"]',
        'iframe[src*="doubleclick.net"]',
        'iframe[src*="googleads"]',
        '.simple-moyan-member-badge',
        '.simple-moyan-member-popover',
        '#metaSlot',                    // “AI 写同款 · 一键分发”推广
        '.toolbar-btn-vip',             // 顶部“会员·新人礼包”推广

        // ---------- ask.csdn.net 问答页 ----------
        '.detail-shell-ad',             // 问答详情页左右/背景广告外壳
        '.csdn-vip-motion',             // VIP 动效皮肤广告
        '.ask-detail-commercial',       // 问答正文中插入的商业推广卡
        '.ask-moyan',                   // “墨衍会员”推广徽章
        '.ask-logoin-user2',            // 首页右侧“向专家提问/向AI提问”推广卡

        // ---------- bbs.csdn.net 论坛 ----------
        '.bbs-banner',                  // 论坛首页横幅（广告/活动推广）

        // ---------- 关注相关（底部固定关注条、作者关注按钮等） ----------
        '#simple-sticky-userbar',
        '.simple-sticky-userbar-wrap',
        '#simple-article-follow-btn',
        '.simple-article-follow-btn',
        '.seo-author-actions',
        '#simple-sticky-follow-btn',
        '.simple-sticky-userbar__btn',
        '#btnAttent',
        '[class*="follow"]',
        '[id*="follow"]',
        '[class*="attent"]',
        '[id*="attent"]',
        '.fans_read_more',
        '.personal-watch',

        // ---------- 阻断阅读的浮层 / 推广 ----------
        '#article_content > a > img',
        '.hide-article-box',
        '.hide-preCode-box',
        '.read_more_mask',
        '.mask-lock-box',
        '.btn_open_app_prompt_div',
        '.feed-Sign-weixin',
        '#treeSkill',
        '#recommendNps',
        '.template-box',
        '#copyright-box',
        '#blogColumnPayAdvert',
        '.tool-active-list',
        '.recommend-ask-box',
        '.write-guide-buttom-box',
        '.csdn-side-toolbar > *:not(:last-child)'
    ];

    // 所有内容类 CSDN 子站通用：背景、推荐区展开、代码可选中
    const GENERIC_CSS = [
        // ---------- 去掉背景皮肤，统一白底 ----------
        'html,body{background:#fff !important;background-image:none !important;}',
        'html.has-simple-ad-background-skin,body.has-simple-ad-background-skin,html.has-simple-ad-background-skin.has-vip-skin-ad,body.has-simple-ad-background-skin.has-vip-skin-ad,#csdn-main-father-root.has-ad-slots{background:#fff !important;background-image:none !important;}',
        'body.has-simple-ad-background-skin::before,body.has-simple-ad-background-skin::after,body.has-vip-skin-ad::before,body.has-vip-skin-ad::after{display:none !important;}',
        '#csdn-main-father-root,#mainBox,.detail_container,.ask-detail-shell{background-color:transparent !important;background-image:none !important;}',
        '.nuxt_main_container{background:#fff !important;background-image:none !important;}',

        // ---------- 保留推荐文章，同时展开其高度 ----------
        '.recommend-box,.recommend-right,.simple-recommend,.detail-shell-recommend{max-height:unset !important;overflow:visible !important;}',

        // ---------- 代码可选中 ----------
        'code{user-select:text !important;-webkit-user-select:text !important;}',
        'pre{user-select:text !important;-webkit-user-select:text !important;}'
    ];

    // 仅 blog.csdn.net 的布局微调
    const BLOG_CSS = [
        // ---------- 展开全文 / 正文 ----------
        '.article_content{height:auto !important;max-height:unset !important;}',
        '#content_views{max-height:unset !important;overflow:visible !important;}',

        // ---------- 顶部导航 / 返回顶部 ----------
        '#csdn-toolbar > .container{width:30% !important;}',
        'div.meau-gotop-box{left:unset !important;}',

        // ---------- 评论区完整展开 ----------
        'div.comment-list-box{max-height:unset !important;}',

        // ---------- 文章留白（修正原脚本中 80px; !important 的语法错误） ----------
        'article{padding-top:32px !important;padding-bottom:80px !important;}',

        // ---------- 底部点赞栏从 fixed 改为 static ----------
        '.left-toolbox{position:static !important;}',

        // ---------- 代码块展开 ----------
        '.set-code-hide{height:auto !important;overflow-y:hidden !important;max-height:unset !important;}'
    ];

    // 仅 ask.csdn.net 的内容展开
    const ASK_CSS = [
        '.question_show_box,.answer-content-item,.detail_content{max-height:unset !important;overflow:visible !important;}'
    ];

    const CSS_TEXT =
        REMOVE_SELECTORS.map(function (sel) { return sel + '{display:none !important;}'; }).join('\n') +
        '\n' + GENERIC_CSS.join('\n') +
        (IS_BLOG ? '\n' + BLOG_CSS.join('\n') : '') +
        (IS_ASK ? '\n' + ASK_CSS.join('\n') : '');

    /**
     * 问答页（Nuxt）会用 html.has-simple-ad-background-skin.has-vip-skin-ad
     * 这类高优先级规则设置渐变皮肤，纯 CSS 可能被页面后加载的样式覆盖。
     * 这里用内联 !important 强制去掉背景，内联样式优先级最高。
     */
    function forceWhiteBackground() {
        try {
            [
                document.documentElement,
                document.body,
                document.querySelector('.nuxt_main_container')
            ].forEach(function (el) {
                if (!el) return;
                el.style.setProperty('background-image', 'none', 'important');
                el.style.setProperty('background-color', '#fff', 'important');
            });
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 注入样式。
     * 原脚本使用 XML processing instruction（xml-stylesheet），在 HTML 文档中
     * documentElement 尚未创建时会报错；这里改为普通 <style> + MutationObserver。
     */
    function injectStyles() {
        const style = document.createElement('style');
        style.id = 'csdn-simplify-style';
        style.textContent = CSS_TEXT;

        function add() {
            // 已存在则刷新内容，避免脚本更新后仍使用旧样式
            const existing = document.getElementById('csdn-simplify-style');
            if (existing) { existing.textContent = CSS_TEXT; return true; }
            const parent = document.head || document.documentElement;
            if (!parent) return false;
            parent.appendChild(style);
            return true;
        }

        if (add()) return;
        const observer = new MutationObserver(function () {
            if (add()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
    }

    /* ==========================================================================
     * 5. 动态广告清理
     * --------------------------------------------------------------------------
     * CSS 负责“隐藏”，MutationObserver 负责在广告节点插入时直接移除，
     * 避免广告 iframe 继续加载。只移除广告/背景节点，
     * 绝不碰 .recommend-box / .recommend-right / .simple-recommend 等推荐区域。
     * ========================================================================== */
    const AD_NODE_SELECTOR = [
        '.simple-ad-slot', '.simple-ad-slot__fixed', '.simple-ad-bg',
        '[id^="kp_box_"]', '.toolbar-advert', '.csdn-toolbar-creative-mp',
        '.pulllog-box', '#dmp_ad_58', '.recommend-ad-box', '.type_hot_word',
        '.article-ad', '.blog_top_ad', '.ad-top', '.ad-bottom', '.ad-box', '.adsbygoogle'
    ].join(',');

    const AD_IFRAME_RE = /pos\.baidu\.com|cpro\.baidu\.com|dup\.baidustatic\.com|gdt\.qq\.com|doubleclick\.net|googleads|googlesyndication/i;

    function purgeAds(root) {
        const scope = (root && root.querySelectorAll) ? root : document;
        try {
            scope.querySelectorAll(AD_NODE_SELECTOR).forEach(function (el) { el.remove(); });
            scope.querySelectorAll('iframe[src]').forEach(function (frame) {
                if (AD_IFRAME_RE.test(frame.src)) frame.remove();
            });
            if (root && root.nodeType === 1 && root !== document.documentElement) {
                if (root.matches && root.matches(AD_NODE_SELECTOR)) root.remove();
                if (root.tagName === 'IFRAME' && AD_IFRAME_RE.test(root.src)) root.remove();
            }
        } catch (e) { /* 忽略清理异常，避免影响阅读 */ }
    }

    function installAdPurge() {
        purgeAds(document);
        const observer = new MutationObserver(function (mutations) {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) purgeAds(node);
                }
            }
        });
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
        // 兜底：有些广告是在已有节点内部动态改内容插入的
        setInterval(function () { purgeAds(document); }, 3000);
    }

    /* ==========================================================================
     * 6. 解除复制限制 / 代码展开（原脚本逻辑的现代化重写）
     * ========================================================================== */
    function unlockCopy() {
        // CSDN 未登录时会把复制函数替换成 signin（弹登录），这里改回真正的复制函数
        try {
            if (window.mdcp && typeof window.mdcp.copyCode === 'function') {
                window.mdcp.signin = window.mdcp.copyCode;
            }
        } catch (e) { /* 忽略 */ }

        try {
            if (window.hljs && typeof window.hljs.copyCode === 'function') {
                window.hljs.signin = window.hljs.copyCode;
            }
        } catch (e) { /* 忽略 */ }

        // 解除 jQuery 绑定的 copy 限制
        try {
            if (window.jQuery) window.jQuery('#content_views').off('copy');
        } catch (e) { /* 忽略 */ }

        const content = document.getElementById('content_views');
        if (content) {
            content.oncopy = null;
            content.querySelectorAll('[oncopy],[oncut],[oncontextmenu]').forEach(function (el) {
                el.removeAttribute('oncopy');
                el.removeAttribute('oncut');
                el.removeAttribute('oncontextmenu');
            });
        }

        // 代码块全部展开
        document.querySelectorAll('.set-code-hide').forEach(function (el) {
            el.style.height = 'auto';
            el.style.maxHeight = 'none';
            el.style.overflowY = 'hidden';
        });

        // 代码文本可选中
        document.querySelectorAll('code, pre').forEach(function (el) {
            el.style.userSelect = 'text';
            el.style.webkitUserSelect = 'text';
        });
    }

    /* ==========================================================================
     * 7. 安全网：万一仍然被跳到登录页，提供“返回原文章”按钮
     * --------------------------------------------------------------------------
     * window.name 可以跨域、跨导航保留，用它传递文章地址。
     * 只在“来源页确实是同一篇 CSDN 文章”且 10 分钟内有效时才显示按钮，
     * 避免误伤正常登录流程。
     * ========================================================================== */
    const BACK_KEY = 'CSDN_GUARD_BACK::';
    const BACK_TTL = 10 * 60 * 1000;

    function saveBackTarget() {
        try {
            const current = String(window.name || '');
            // 不覆盖其它站点/脚本使用的 window.name
            if (current && current.indexOf(BACK_KEY) !== 0) return;
            window.name = BACK_KEY + JSON.stringify({
                url: location.href,
                time: Date.now()
            });
        } catch (e) { /* 忽略 */ }
    }

    function installBackButton() {
        let data = null;
        try {
            const name = String(window.name || '');
            if (name.indexOf(BACK_KEY) === 0) {
                data = JSON.parse(name.slice(BACK_KEY.length));
            }
        } catch (e) { return; }

        if (!data || !data.url || !data.time) return;
        if (Date.now() - data.time > BACK_TTL) return;
        if (!/^https?:\/\/([a-z0-9-]+\.)?csdn\.net\//.test(data.url)) return;

        // 只有确实是从同一篇文章跳到登录页时才显示按钮
        let sameArticle = false;
        try {
            const from = new URL(data.url);
            const referrer = new URL(document.referrer);
            sameArticle = from.hostname === referrer.hostname && from.pathname === referrer.pathname;
        } catch (e) {
            sameArticle = false;
        }
        if (!sameArticle) return;

        function render() {
            if (document.getElementById('csdn-back-to-article')) return;
            const btn = document.createElement('button');
            btn.id = 'csdn-back-to-article';
            btn.type = 'button';
            btn.textContent = '← 返回原 CSDN 页面';
            btn.style.cssText = [
                'position:fixed', 'right:24px', 'bottom:32px', 'z-index:2147483647',
                'padding:10px 16px', 'border:0', 'border-radius:8px',
                'background:#fc5531', 'color:#fff', 'font-size:14px', 'cursor:pointer',
                'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif',
                'box-shadow:0 6px 20px rgba(252,85,49,.35)'
            ].join(';');
            btn.addEventListener('click', function () {
                try { window.name = ''; } catch (e) { /* 忽略 */ }
                location.replace(data.url);
            });
            (document.body || document.documentElement).appendChild(btn);
        }

        if (document.body) render();
        else document.addEventListener('DOMContentLoaded', render, { once: true });
    }

    /* ==========================================================================
     * 兼容旧版脚本
     * --------------------------------------------------------------------------
     * 旧版“CSDN免登录+极简化”通过 xml-stylesheet 处理指令注入样式，
     * 其中隐藏了 .recommend-box / .recommend-right。若旧脚本仍然启用，
     * 会与本脚本“保留推荐文章”的目标冲突，这里主动禁用它的样式表。
     * ========================================================================== */
    function disableLegacyStyles() {
        try {
            Array.from(document.styleSheets).forEach(function (sheet) {
                const href = sheet.href || '';
                if (href.indexOf('data:text/css') === 0 &&
                    href.indexOf('passport-login-tip-container') !== -1 &&
                    href.indexOf('recommend-box') !== -1) {
                    sheet.disabled = true;
                }
            });
        } catch (e) { /* 忽略 */ }
        try {
            Array.prototype.forEach.call(document.childNodes, function (node) {
                if (node.nodeType === 7 && node.target === 'xml-stylesheet') {
                    const data = String(node.data || '');
                    if (data.indexOf('passport-login-tip-container') !== -1) node.remove();
                }
            });
        } catch (e) { /* 忽略 */ }
    }

    /* ==========================================================================
     * 8. 入口
     * ========================================================================== */
    if (IS_PASSPORT) {
        // 登录页只负责“返回原文”安全网，不安装任何登录守卫，避免影响正常登录
        installBackButton();
        return;
    }

    if (!IS_CSDN) return;

    // 所有 CSDN 子站共用 csdn-toolbar.js / csdn-login-box.js：统一阻止自动登录跳转
    installLoginBoxGuard();
    suppressAutoLoginBoxCookie();

    // 商城、直播、创作中心等页面只保留登录守卫，避免误伤
    if (!IS_CONTENT_SITE) return;

    injectStyles();
    forceWhiteBackground();
    // ask/bbs 等是现代前端应用，直接删除节点可能破坏水合；只有传统博客页做节点移除
    if (IS_BLOG) installAdPurge();
    saveBackTarget();
    disableLegacyStyles();
    setTimeout(disableLegacyStyles, 1000);
    setTimeout(disableLegacyStyles, 3000);
    setTimeout(forceWhiteBackground, 1000);
    setTimeout(forceWhiteBackground, 3000);

    // 复制限制/代码展开在页面脚本初始化之后才生效，分多次重试
    function unlockLater() {
        unlockCopy();
        setTimeout(unlockCopy, 1500);
        setTimeout(unlockCopy, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', unlockLater, { once: true });
        window.addEventListener('load', unlockLater, { once: true });
    } else {
        unlockLater();
    }
})();
