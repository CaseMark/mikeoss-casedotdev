import { redirect } from "next/navigation";

interface Props {
    params: Promise<{ id: string; reviewId: string }>;
}

export default async function ProjectTabularReviewPage({ params }: Props) {
    const { id, reviewId } = await params;
    redirect(`/matters/${id}/tabular-reviews/${reviewId}`);
}
