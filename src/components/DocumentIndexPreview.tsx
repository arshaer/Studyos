"use client";
import { useState } from "react";
import { DocumentScopePicker,type DocumentScope } from "@/components/DocumentScopePicker";
export function DocumentIndexPreview({documentId,pageCount}:{documentId:string;pageCount?:number|null}){
  const[open,setOpen]=useState(false),[scope,setScope]=useState<DocumentScope>({type:"sections",sectionIds:[]});
  return <div className="library-index"><button className="read-button" onClick={()=>setOpen(!open)}>{open?"Hide index":"Browse index"}</button>{open&&<DocumentScopePicker documentId={documentId} pageCount={pageCount} value={scope} onChange={setScope}/>}</div>
}
