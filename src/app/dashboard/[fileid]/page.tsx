interface PageProps {
  params: {
    fileid: string;
  };
}

const Page = ({ params }: PageProps) => {
  const { fileid } = params;
  

  return <div>{fileid}</div>;
};

export default Page;

Add the Page component to the dashboard/[fileid] route to display the details of a specific file.