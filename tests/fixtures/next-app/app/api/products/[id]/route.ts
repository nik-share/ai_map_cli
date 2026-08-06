// @ts-nocheck
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return Response.json({ id });
}

export async function POST(request: Request): Promise<Response> {
  await request.json();
  return new Response(null, { status: 204 });
}
