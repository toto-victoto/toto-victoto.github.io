import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  route("rps", "routes/rps.tsx"),
  route("snake", "routes/snake.tsx"),
  route("flappy", "routes/flappy.tsx"),
  route("roulette", "routes/roulette.tsx"),
  route("morpion", "routes/morpion.tsx"),
] satisfies RouteConfig;
