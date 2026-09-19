export const THEME_KEY = "s98_display_mode";
export const THEME_BOOT = `try{document.documentElement.dataset.theme=localStorage.getItem("${THEME_KEY}")==="win98"?"win98":"modern"}catch(e){document.documentElement.dataset.theme="modern"}`;
