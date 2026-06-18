/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['react-leaflet', '@react-leaflet/core'],
};

module.exports = nextConfig;
