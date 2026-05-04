import { redirect } from "next/navigation";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({ params }: Props) {
    const { id } = await params;
    redirect(`/matters/${id}`);
}
