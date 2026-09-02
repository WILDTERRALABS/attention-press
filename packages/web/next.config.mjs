/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@attention-press/reader-sdk"],
  webpack: (config, { webpack }) => {
    // The wagmi/connectors barrel pulls in connectors we don't use (baseAccount,
    // walletConnect), which reference optional deps @x402/* and pino-pretty.
    // Only the `injected` connector is configured, so ignore those.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(@x402(\/|$)|pino-pretty$|@react-native-async-storage\/async-storage$)/,
      }),
    );
    return config;
  },
};

export default nextConfig;
