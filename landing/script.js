// CloudeIDE marketing site — no framework, no build step.
//
// The app lives at /app on this same domain (cloudeide.com/app), so Sign In
// and Get Started are plain root-relative links in the HTML — no runtime
// rewriting needed.

// Mobile nav toggle.
const navToggle = document.getElementById("navToggle");
const mobileMenu = document.getElementById("mobileMenu");

if (navToggle && mobileMenu) {
  navToggle.addEventListener("click", () => {
    const isOpen = !mobileMenu.hidden;
    mobileMenu.hidden = isOpen;
    navToggle.setAttribute("aria-expanded", String(!isOpen));
  });

  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      mobileMenu.hidden = true;
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

// Reveal-on-scroll for elements marked .reveal — a plain opacity/translate
// fade, not a "flashy effect": disabled entirely under reduced-motion via CSS.
const revealTargets = document.querySelectorAll(".reveal");

// The guard in <head> waits for this before leaving anything hidden.
window.__revealReady = true;

if ("IntersectionObserver" in window && revealTargets.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  revealTargets.forEach((el) => observer.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add("is-visible"));
}

// Footer year.
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// Copy buttons on the CLI commands.
//
// The text comes from data-copy rather than from the element's text content,
// so the `$` prompt shown on screen is never part of what lands on the
// clipboard — a pasted prompt character is a broken command.
//
// navigator.clipboard needs a secure context and can still be refused by the
// browser, so a failure says so instead of showing a success that did not
// happen. The label restores itself either way.
document.querySelectorAll(".cli-copy").forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy");
    if (!text) return;

    const restore = (label, copied) => {
      button.textContent = label;
      button.classList.toggle("is-copied", copied);
      window.setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("is-copied");
      }, 1600);
    };

    try {
      await navigator.clipboard.writeText(text);
      restore("Copied", true);
    } catch {
      restore("Press \u2318C", false);
    }
  });
});

/*
 * The films play when they reach the screen, and not before.
 *
 * They used to carry `autoplay`, which starts two multi-megabyte downloads the
 * moment the markup is parsed — ahead of this very file, which is loaded at the
 * end of the body. On a phone connection that is enough to hold the script up
 * long enough for the page to sit there with every section still invisible,
 * which is exactly what it did. Now nothing is fetched until a film is in view,
 * and the second one costs nothing to anyone who never scrolls to it.
 */
// The hero film still runs full-bleed in `.filmstrip`; the two product films
// moved into `.window` frames inside the showcases. Both play the same way.
const films = document.querySelectorAll(".filmstrip video, .window video");
const stillFilms = window.matchMedia("(prefers-reduced-motion: reduce)");

if (films.length) {
  /*
   * The wide poster, where the wide film plays.
   *
   * `poster` takes one value, but the two cuts of a film are not the same
   * picture: the wide one is the whole workbench and the narrow one is the
   * panel alone, cropped from the right of it. A poster from the wrong cut is
   * not a smaller version of the film, it is a different shot stretched into
   * a box it was never framed for. Same 760px line the <source> elements use,
   * and kept in step afterwards, because that line is crossed by turning a
   * phone sideways as well as by loading the page.
   */
  const wideFilms = window.matchMedia("(min-width: 760px)");
  const applyPosters = () => {
    films.forEach((film) => {
      const wide = film.dataset.posterWide;
      if (!wide) return;
      film.dataset.posterNarrow = film.dataset.posterNarrow || film.getAttribute("poster");
      film.setAttribute("poster", wideFilms.matches ? wide : film.dataset.posterNarrow);
    });
  };
  applyPosters();
  wideFilms.addEventListener("change", applyPosters);

  /*
   * Starting a film is not one call, because there are three separate reasons
   * a browser refuses one.
   *
   *  - `muted` is set as a property as well as an attribute. Some mobile
   *    browsers read the property when deciding whether a scripted play() is
   *    allowed without a gesture, and an attribute alone does not set it.
   *  - Data Saver, Low Power Mode and similar refuse the first attempt
   *    outright. They stop refusing after the person touches the page, so a
   *    rejection arms a one-shot retry on the next interaction rather than
   *    giving up.
   *  - Nothing here can make a film appear if it never plays, which is why
   *    each one carries a `poster`: a still of the film is what a viewer sees
   *    in every case above, instead of the empty box they saw before.
   */
  let waitingForGesture = false;
  const GESTURES = ["pointerdown", "touchstart", "keydown", "scroll"];

  const retryOnGesture = () => {
    if (waitingForGesture) return;
    waitingForGesture = true;
    const go = () => {
      GESTURES.forEach((g) => window.removeEventListener(g, go));
      waitingForGesture = false;
      films.forEach((film) => {
        if (isOnScreen(film)) start(film);
      });
    };
    GESTURES.forEach((g) => window.addEventListener(g, go, { once: true, passive: true }));
  };

  const isOnScreen = (film) => {
    const r = film.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  };

  const start = (film) => {
    if (stillFilms.matches) return;
    film.muted = true;
    const attempt = film.play();
    if (attempt && typeof attempt.catch === "function") attempt.catch(retryOnGesture);
  };

  const playWhenSeen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) start(entry.target);
        else entry.target.pause();
      }
    },
    { threshold: 0.2 },
  );
  films.forEach((film) => playWhenSeen.observe(film));

  // Someone who turns the preference on mid-visit should get stillness now,
  // not on their next page load.
  stillFilms.addEventListener("change", () => {
    films.forEach((film) => {
      if (stillFilms.matches) film.pause();
      else if (isOnScreen(film)) start(film);
    });
  });
}

/* --------------------------------------------------------------- download --
 *
 * The button is whichever platform the visitor is on; the other two become
 * links beside it, and only that platform's note is shown.
 *
 * The markup already holds all three, all working. This only reorders and
 * hides — so a visitor with no JavaScript, or one this guesses wrong about,
 * still has every download a click away. That is why nothing here removes an
 * element from the page.
 *
 * Apple Silicon is not detected, because it cannot be: Safari and Chrome both
 * report "MacIntel" on an M-series Mac. The Mac note says which build it is
 * instead of this pretending to know.
 */
{
  const row = document.querySelector("[data-download]");
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  const here = /mac/i.test(platform) || /Mac OS X/i.test(ua)
    ? "mac"
    : /win/i.test(platform) || /Windows/i.test(ua)
      ? "windows"
      : /linux|android|cros/i.test(platform) || /Linux|Android|CrOS/i.test(ua)
        ? "linux"
        : null;

  const buttons = row ? [...row.querySelectorAll("[data-os]")] : [];
  const mine = here ? buttons.find((b) => b.dataset.os === here) : undefined;

  // Only when there is a button for this platform. Without that guard, a
  // platform whose build is not published yet — or has been pulled — promotes
  // nothing and hides every note, leaving a download row with no note under
  // it at all.
  if (mine) {
    buttons.forEach((b) => {
      const isMine = b === mine;
      b.classList.toggle("btn-primary", isMine);
      b.classList.toggle("btn-secondary", !isMine);
      b.classList.toggle("download-other", !isMine);
      // "Windows", not "Download for Windows". Demoted, the verb is carried
      // by the button beside it, and three long labels wrap onto a second
      // line for no reason. The long one stays in the markup so that without
      // this the row still reads as a sentence.
      if (!isMine && b.dataset.osShort) {
        b.textContent = b.dataset.osShort;
      }
    });

    // First in the row, so the button a visitor wants is the one their eye
    // lands on rather than the one that happened to be authored first.
    row.prepend(mine);

    document.querySelectorAll("[data-note]").forEach((note) => {
      note.hidden = note.dataset.note !== here;
    });
  }
}
