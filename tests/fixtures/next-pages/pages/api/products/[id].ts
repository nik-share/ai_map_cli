// @ts-nocheck
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(request: NextApiRequest, response: NextApiResponse) {
  response.status(200).json({ id: request.query.id });
}
