// @ts-nocheck
import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async ({ params }) => ({
  props: { id: params?.id },
});

export default function ProductPage({ id }: { id: string }) {
  return <article>{id}</article>;
}
