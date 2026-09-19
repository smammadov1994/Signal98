/** @type {import('next').NextConfig} */
const nextConfig = {
  // native/CJS packages that must be required at runtime, not bundled
  serverExternalPackages: ["web-push", "nodemailer"],
  async headers() {
    return [
      // the script-tag SDK is loaded cross-origin by customer sites
      { source: "/s98.js", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }, { key: "Cache-Control", value: "public, max-age=300" }] },
    ];
  },
};
export default nextConfig;
