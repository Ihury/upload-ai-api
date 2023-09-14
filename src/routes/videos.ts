import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fastifyMultipart } from "@fastify/multipart";
import { prisma } from "../lib/prisma";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import fs, { createReadStream } from "node:fs";
import { z } from "zod";
import { openai } from "../lib/openai";
import { streamToResponse, OpenAIStream } from "ai";

const pump = promisify(pipeline);

export async function videosRoute(app: FastifyInstance) {
  app.register(fastifyMultipart, {
    limits: {
      fileSize: 1_848_576 * 25, // 25mb
    },
  });

  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();

    if (!data) {
      return reply.status(400).send({
        error: "Missing file input.",
      });
    }

    const extension = path.extname(data.filename);

    if (![".mp3"].includes(extension)) {
      return reply.status(400).send({
        error: "Invalid input type, please upload a .mp3 file.",
      });
    }

    const fileBaseName = path.basename(data.filename, extension);
    const fileUploadName = `${fileBaseName}-${randomUUID()}${extension}`;

    const uploadDestination = path.resolve(
      __dirname,
      "../",
      "../",
      "tmp",
      fileUploadName
    );

    await pump(data.file, fs.createWriteStream(uploadDestination));

    const video = await prisma.video.create({
      data: {
        name: data.filename,
        path: uploadDestination,
      },
    });

    return { video };
  });

  app.post(
    "/:videoId/transcription",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsSchema = z.object({
        videoId: z.string(),
      });

      const { videoId } = paramsSchema.parse(request.params);

      const bodySchema = z.object({
        prompt: z.string(),
      });

      const { prompt } = bodySchema.parse(request.body);

      const video = await prisma.video.findUnique({
        where: {
          id: videoId,
        },
      });

      if (!video) {
        return reply.status(404).send({
          error: "Video not found.",
        });
      }

      const videoPath = video.path;

      const audioReadStream = createReadStream(videoPath);

      try {
        const response = await openai.audio.transcriptions.create({
          file: audioReadStream,
          model: "whisper-1",
          language: "pt",
          response_format: "json",
          temperature: 0,
          prompt,
        });

        const transcription = response.text;

        await prisma.video.update({
          where: {
            id: videoId,
          },
          data: {
            transcription,
          },
        });

        return { transcription };
      } catch (err) {
        console.error(err);
        return reply.status(500).send({ error: "Internal server error." });
      }
    }
  );

  app.post(
    "/:videoId/complete",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsSchema = z.object({
        videoId: z.string(),
      });

      const { videoId } = paramsSchema.parse(request.params);

      const bodySchema = z.object({
        prompt: z.string(),
        temperature: z.number().min(0).max(1).default(0.5),
      });

      const { prompt, temperature } = bodySchema.parse(request.body);

      const video = await prisma.video.findUnique({
        where: {
          id: videoId,
        },
      });

      if (!video) {
        return reply.status(404).send({
          error: "Video not found.",
        });
      }

      if (!video.transcription) {
        return reply.status(400).send({
          error: "Video transcription was not generated yet.",
        });
      }

      const promptMessage = prompt.replace(
        "{transcription}",
        video.transcription
      );

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo-16k",
        temperature,
        messages: [
          {
            role: "user",
            content: promptMessage,
          },
        ],
        stream: true,
      });

      const stream = OpenAIStream(response);

      streamToResponse(stream, reply.raw, {
        headers: {
          "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        },
      });
    }
  );
}
