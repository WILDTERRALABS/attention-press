import { ArticleReader } from "@/components/ArticleReader";

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ArticleReader id={id} />;
}
