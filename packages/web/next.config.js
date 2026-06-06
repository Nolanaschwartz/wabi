/** @type {import('next').NextConfig} */
const nextConfig = {
	transpilePackages: ["@wabi/shared"],
	webpack: (config) => {
		config.resolve.alias["@"] = config.context + "/src";
		return config;
	},
};

export default nextConfig;
