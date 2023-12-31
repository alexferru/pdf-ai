import { db } from "@/db";
import { sendMessageValidator } from "@/lib/validators/SendMessageValidator";
import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { NextRequest } from "next/server";
import { pinecone } from "@/lib/pinecone";
import { PineconeStore } from "langchain/vectorstores/pinecone";

import { OpenAIStream, StreamingTextResponse } from "ai";
import { openai } from "@/lib/openai";

interface SearchResult {
  pageContent: string;
  metadata: {
    fileName: string;
  };
}

function customFilter(result: SearchResult, targetFileName: string): boolean {
  return result.metadata?.fileName === targetFileName;
}

export const POST = async (req: NextRequest) => {
  const body = await req.json();

  const { getUser } = getKindeServerSession();
  const user = getUser();

  const { id: userId } = user;

  if (!userId) return new Response("Unauthorized", { status: 401 });

  const { fileId, message } = sendMessageValidator.parse(body);

  const file = await db.file.findFirst({
    where: {
      id: fileId,
      userId,
    },
  });

  if (!file) return new Response("Not found", { status: 404 });

  await db.message.create({
    data: {
      text: message,
      isUserMessage: true,
      userId,
      fileId,
    },
  });

  //vectorize message
  const embeddings = new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  const pineconeIndex = pinecone.Index("dkmnt1");

  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
  });

  try {
    // Search for similar messages using the file ID as context
    const results = await vectorStore.similaritySearch(message, 1, {
      filter: (result: SearchResult) => customFilter(result, file.id),
    });
    const prevMessages = await db.message.findMany({
      where: { fileId },
      orderBy: { createdAt: "asc" },
      take: 6,
    });
    const formattedPrevMessages = prevMessages.map((msg) => ({
      role: msg.isUserMessage ? "user" : "assistant",
      content: msg.text,
    }));

    // Construct a context string with previous conversation, results, and user input
    const context = `PREVIOUS CONVERSATION:${formattedPrevMessages.map(
      (msg) => {
        if (msg.role === "user") return `User:${msg.content}\n`;
        return `Assistant:${msg.content}\n`;
      }
    )}CONTEXT:${results
      .map((r) => r.pageContent)
      .join("\n\n")}USER INPUT:${message}`;

    // Use a system message to instruct the model
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      temperature: 0.7, // Adjust the temperature as needed
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You have access to a PDF document. Please use the information from the document to answer the user's question.",
        },
        {
          role: "user",
          content: context, // Provide the context here
        },
      ],
    });

    const stream = OpenAIStream(response, {
      async onCompletion(completion) {
        await db.message.create({
          data: {
            text: completion,
            isUserMessage: false,
            fileId,
            userId,
          },
        });
      },
    });

    return new StreamingTextResponse(stream);
  } catch (error) {
    console.error("Error searching for similar messages:", error);
    return new Response("InternalServerError", { status: 500 });
  }
};
