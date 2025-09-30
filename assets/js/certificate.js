// Generación de Certificado en PDF (jsPDF)
// - generateCertificate(cert) => descarga inmediata
// - generateCertificateBlob(cert) => devuelve Blob (para subir a Storage)

const { jsPDF } = window.jspdf;

function drawCertificate(doc, cert){
  const pageW = doc.internal.pageSize.getWidth();

  // Encabezado
  doc.setFont("helvetica","bold"); doc.setFontSize(18);
  doc.text("Constancia de Aprobación de Calidad y Documentación", pageW/2, 60, {align:"center"});

  doc.setFont("helvetica","normal"); doc.setFontSize(12);

  const line=(y,l,v)=>{doc.setFont("helvetica","bold");doc.text(l,60,y);doc.setFont("helvetica","normal");doc.text(String(v??""),220,y);};
  let y=110;

  line(y,"Certificado Nº:", cert.certificate_number ?? "—"); y+=22;
  line(y,"Empresa:", cert.empresa); y+=22;
  line(y,"RUC:", cert.ruc ?? "—"); y+=22;
  line(y,"Producto:", cert.producto); y+=22;
  line(y,"Variedad:", cert.variedad ?? "—"); y+=22;
  line(y,"Lote:", cert.lote); y+=22;
  line(y,"Origen:", cert.origen ?? "—"); y+=22;
  line(y,"Destino:", cert.destino); y+=22;
  line(y,"Fecha de emisión:", cert.fecha); y+=22;
  line(y,"Estado:", cert.estado ? "APROBADO" : "RECHAZADO"); y+=30;

  doc.setFont("helvetica","bold");
  doc.text("Observaciones:", 60, y);
  doc.setFont("helvetica","normal");
  const obs = doc.splitTextToSize(cert.observaciones || "Sin observaciones", pageW - 120);
  doc.text(obs, 60, y + 18);

  // Declaración corta
  const declY = y + 60 + (obs.length * 12);
  doc.setFont("helvetica","bold");
  doc.text("Declaración:", 60, declY);
  doc.setFont("helvetica","normal");
  const decl = "Se certifica que la documentación y calidad del lote descrito cumple con los criterios establecidos para su exportación, de acuerdo a los requisitos vigentes informados por las entidades competentes.";
  doc.text(doc.splitTextToSize(decl, pageW-120), 60, declY + 18);

  // Pie
  doc.setFont("helvetica","italic"); doc.setFontSize(10);
  doc.text("Documento generado por AgroCheck.", 60, 780);
}

window.generateCertificate = async function(cert){
  const doc = new jsPDF({ unit:"pt", format:"A4" });
  drawCertificate(doc, cert);
  const filename = `Constancia_${(cert.lote||"lote").replace(/\W+/g,"_")}.pdf`;
  doc.save(filename);
};

window.generateCertificateBlob = function(cert){
  const doc = new jsPDF({ unit:"pt", format:"A4" });
  drawCertificate(doc, cert);
  return doc.output("blob");
};
