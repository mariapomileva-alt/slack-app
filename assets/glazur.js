(function () {
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function normPath(p) {
    if (p == null || p === "") return "/";
    var s = String(p).replace(/\/+$/, "");
    return s === "" ? "/" : s;
  }

  /** На главной иногда якорь /#story не прокручивает; пути сравниваем в нормализованном виде (/, /en-us). */
  function storyNavFromHeader() {
    $$("#site-nav a.nav__story").forEach(function (a) {
      a.addEventListener("click", function (e) {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var story = document.getElementById("story");
        var raw = a.getAttribute("href");
        if (!raw || raw === "#") return;
        var u;
        try {
          u = new URL(raw, window.location.origin);
        } catch (err) {
          return;
        }
        if (u.hash !== "#story") return;
        if (normPath(u.pathname) !== normPath(window.location.pathname)) return;
        if (!story) return;
        e.preventDefault();
        story.scrollIntoView({ behavior: "smooth", block: "start" });
        try {
          history.replaceState(null, "", u.pathname + (u.search || "") + "#story");
        } catch (e2) {}
      });
    });
  }

  function navToggle() {
    var btn = $("#nav-toggle");
    var nav = $("#site-nav");
    if (!btn || !nav) return;
    btn.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $$("#site-nav a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("is-open");
        btn.setAttribute("aria-expanded", "false");
      });
    });
  }

  function promoBar() {
    var bar = $("#promo-bar");
    if (!bar) return;
    var dismissed = false;
    try {
      dismissed = sessionStorage.getItem("glazur_promo_dismiss") === "1";
    } catch (e) {}
    if (dismissed) {
      bar.hidden = true;
      document.body.classList.remove("has-promo");
      return;
    }
    bar.hidden = false;
    document.body.classList.add("has-promo");
    var close = $("#promo-close");
    if (close) {
      close.addEventListener("click", function () {
        bar.hidden = true;
        document.body.classList.remove("has-promo");
        try {
          sessionStorage.setItem("glazur_promo_dismiss", "1");
        } catch (e2) {}
      });
    }
  }

  function promoModal() {
    var openBtn = $("#promo-open-modal");
    var modal = $("#promo-modal");
    if (!openBtn || !modal) return;
    var overlay = $(".promo-modal__overlay", modal);
    var closeBtn = $(".promo-modal__close", modal);
    var form = $("#promo-form");
    var success = $("#promo-success");

    function open() {
      modal.hidden = false;
      document.body.style.overflow = "hidden";
    }
    function close() {
      modal.hidden = true;
      document.body.style.overflow = "";
    }

    openBtn.addEventListener("click", function (e) {
      e.preventDefault();
      open();
    });
    if (overlay) overlay.addEventListener("click", close);
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (success && success.dataset.openOnLoad === "true") {
      open();
      if (form) form.hidden = true;
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) close();
    });

    if (form) {
      form.addEventListener("submit", function (e) {
        var input = $("#promo-email");
        var em = input && input.value.trim();
        if (!em) return;
        try {
          sessionStorage.setItem("glazur_promo_submit", "1");
        } catch (err) {}
      });
    }
  }

  function footerNewsletter() {
    var f = $("#footer-newsletter-form");
    if (!f) return;
    f.addEventListener("submit", function (e) {
      var native = f.querySelector("[data-shopify-customer-form]");
      if (native) return;
      e.preventDefault();
      var input = f.querySelector('[name="contact[email]"], [name="email"]');
      var em = input && input.value.trim();
      var email = document.body.dataset.contactEmail || "";
      if (!em || !email) return;
      window.location.href =
        "mailto:" +
        email +
        "?subject=" +
        encodeURIComponent("Glazur newsletter — 10% signup") +
        "&body=" +
        encodeURIComponent("Please add:\n" + em);
    });
  }

  function faqAccordion() {
    $$(".faq-item").forEach(function (item) {
      var btn = $("button", item);
      var panel = $(".faq-panel", item);
      if (!btn || !panel) return;
      btn.addEventListener("click", function () {
        var open = item.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
  }

  function yearFooter() {
    var yEl = $("#y");
    if (yEl) yEl.textContent = String(new Date().getFullYear());
  }

  function contactFab() {
    var openBtn = $("#glazur-fab-open");
    var modal = $("#glazur-fab-panel");
    if (!openBtn || !modal) return;
    var closeBtn = $("#glazur-fab-close");
    var backdrop = $("#glazur-fab-backdrop");

    function open() {
      modal.hidden = false;
      openBtn.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
    }
    function close() {
      modal.hidden = true;
      openBtn.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
      try {
        openBtn.focus();
      } catch (e) {}
    }

    openBtn.addEventListener("click", function () {
      if (modal.hidden) open();
      else close();
    });
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (backdrop) backdrop.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) close();
    });
  }

  function init() {
    yearFooter();
    storyNavFromHeader();
    navToggle();
    promoBar();
    promoModal();
    contactFab();
    footerNewsletter();
    faqAccordion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
