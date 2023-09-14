import "dotenv/config";
import { fastify } from "fastify";
import { fastifyCors } from "@fastify/cors";
import { prisma } from "./lib/prisma";
import { promptsRoute } from "./routes/prompts";
import { videosRoute } from "./routes/videos";

const app = fastify();

app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN,
})
app.register(promptsRoute, { prefix: "/prompts" });
app.register(videosRoute, { prefix: "/videos" });

app
  .listen({
    port: 3333,
  })
  .then(() => console.log("HTTP Server is running on port 3333"));
